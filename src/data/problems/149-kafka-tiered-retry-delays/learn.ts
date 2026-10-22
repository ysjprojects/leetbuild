/**
 * The learning guide for Tiered retry topics: the one Kafka mechanism the drill rests on — delayed
 * retries without delayed delivery — with a figure or a demo where one says it faster than prose, a
 * pop quiz per section. Rendered at `/kafka-tiered-retry-delays/learn`; the same Markdown is what
 * the download exports.
 */
export const learn = `# The mechanism at a glance

A worker consumes \`tasks\` and calls a handler per record. When the handler fails — a dependency is
down, a webhook endpoint answers 503 — the record must be tried again *later*, without holding up
the records behind it. Kafka cannot deliver a record later, so the worker builds the delay itself:
**one retry topic per delay**, a \`not_before\` header on each retried record, and a consumer that
**pauses a partition** whose head is not yet due.

:::diagram
{
  "nodes": [
    {"id": "kafka", "kind": "kafka", "label": "tasks", "sub": "group tasks-workers · the main topic, never waits", "x": 15, "y": 50},
    {"id": "worker", "kind": "service", "label": "worker", "sub": "run(handler) · pause a partition until not_before", "x": 50, "y": 50},
    {"id": "retry", "kind": "kafka", "label": "retry tiers", "sub": "tasks.retry.5s · 30s · 5m · tasks.dlq", "x": 85, "y": 50}
  ],
  "edges": [
    {"from": "kafka", "to": "worker", "kind": "kafka", "label": "consume · commit"},
    {"from": "worker", "to": "retry", "kind": "kafka", "label": "hand-off (attempt, not_before) · flush"},
    {"from": "retry", "to": "worker", "kind": "kafka", "label": "consume when due · pause / seek / resume"}
  ]
}
:::

The contract \`run(handler)\` implements:

- One member of group \`tasks-workers\` over \`tasks\`, \`tasks.retry.5s\`, \`tasks.retry.30s\` and
  \`tasks.retry.5m\`, auto-commit off; \`handler(key, value)\` for every record that is due.
- \`TIERS = [5000, 30000, 300000]\` milliseconds, one per retry topic in that order. \`tasks.dlq\` is the
  end of the line.
- A failure hands the record — same key, same value — to the tier whose index is its \`attempt\`, with
  headers \`attempt + 1\`, \`error\` and \`not_before = now + tier\`; after the last tier, to \`tasks.dlq\`.
  The hand-off is acknowledged before the source offset is committed.
- A record whose \`not_before\` is in the future is neither handled nor skipped: its partition is paused
  and seeked back to it, and resumed when the clock reaches \`not_before\`.

Uber's consumer framework, Spring Kafka's \`RetryTopicConfiguration\` and most home-grown
notification and webhook pipelines are built exactly like this.

# Kafka has no delayed delivery

A queue broker such as RabbitMQ or SQS can hold a message back for a while. Kafka cannot: a
partition is an append-only log, and a consumer reads it in offset order from its
[committed position](https://kafka.apache.org/documentation/#design_consumerposition). There is no
"deliver this at 12:05" — only "this is the next record". Everything a delay needs has to be built
on top of that, and the options are few:

| Approach | What the delay costs | Verdict |
| --- | --- | --- |
| Retry in place: catch, try again immediately | nothing — and nothing waits, so the same dead dependency fails it again in milliseconds | no backoff |
| \`sleep\` in the consumer until the record is due | every record behind it on **every** assigned partition, including the main topic's | blocks the world |
| Skip it and commit past it | the record | lost |
| A retry topic, re-consumed immediately | the record leaves the main topic's head, but is retried at once | no backoff |
| One topic per delay + \`not_before\` + \`pause\` | one partition of one retry topic, for exactly the delay | the mechanism |

The delay is **data**, carried on the record itself:

\`\`\`text
topic      tasks.retry.5s
key        a                      — unchanged
value      job-a                  — unchanged
headers    attempt    = "1"       — decimal string; 0 when the header is absent
           error      = "boom"    — the exception's message
           not_before = "1729598405000"   — epoch milliseconds: the failure time + 5000
\`\`\`

Because it is data, it survives a restart of the worker, it is visible to anyone who reads the topic,
and it costs the consumer no thread. A record without \`not_before\` — anything on \`tasks\` — is due
the moment it is read.

:::quiz
Q: A handler fails against a database that is restarting. Why not just catch the exception and call the handler again in a loop?
- [ ] Because the second call would see a different record
- [x] Because the retry happens milliseconds later against the same dead dependency; a delay is needed, and the delay must not block the partition
- [ ] Because Kafka forbids calling a handler twice for one offset
> Retrying in place is backoff without the "off": it hammers the dependency and, if it waits between attempts, stalls the partition. Moving the record to a topic named for its delay gives it time without taking time from anything else.
:::

# One topic per delay, not one retry topic

The obvious design is a single \`tasks.retry\` topic with a per-record \`not_before\`. It fails inside
itself: a consumer reads a partition in order, so a record due in five minutes at the head holds back
a record due in five seconds behind it — head-of-line blocking, moved from the main topic into the
retry topic. With one topic per delay, **every record in a tier waits the same time**, so the head of
a tier's partition is always the first record due, and pausing on it never delays a record that
should have run earlier.

| Attempt that failed | Produced to | \`attempt\` header | \`not_before\` | Headers |
| --- | --- | --- | --- | --- |
| 0 (from \`tasks\`) | \`tasks.retry.5s\` | \`1\` | failure time + 5 000 ms | attempt, error, not_before |
| 1 | \`tasks.retry.30s\` | \`2\` | failure time + 30 000 ms | attempt, error, not_before |
| 2 | \`tasks.retry.5m\` | \`3\` | failure time + 300 000 ms | attempt, error, not_before |
| 3 (from \`tasks.retry.5m\`) | \`tasks.dlq\` | \`4\` | — | attempt, error |

The rule is one line: \`attempt + 1 <= 3\` picks the retry topic at index \`attempt\` and adds
\`TIERS[attempt]\` to the clock; otherwise the record goes to \`tasks.dlq\` with no \`not_before\`, because
nobody will retry it automatically. A record that always fails is therefore seen exactly once on each
retry topic, at a clock time no earlier than each \`not_before\`, and ends on the dead-letter topic
after roughly five and a half minutes.

A single worker consumes all four topics; a record on \`tasks.retry.30s\` is just a record with a later
\`not_before\` and a higher \`attempt\`. The same \`forward(msg, error)\` serves every destination.

:::details Fixed tiers versus per-record backoff
Spring Kafka's
[retry topics](https://docs.spring.io/spring-kafka/reference/retrytopic.html) default to exactly this
shape — one topic per back-off step, a header for the attempt and one for the due time — and
Uber's framework does the same with \`5s\`, \`30s\`, \`5m\` style suffixes. Per-record exponential backoff
with jitter is the better *policy* for a dependency under load, but it only fits in one topic if
the consumer tolerates out-of-order due times; most pipelines take the fixed tiers and put the jitter
in the handler's own client.
:::

:::quiz
Q: Why three retry topics rather than one \`tasks.retry\` topic with a per-record \`not_before\`?
- [ ] Kafka limits a header to one topic
- [x] In one topic a 5-minute record at the head blocks a 5-second record behind it; within a tier every record waits the same time, so the head is always the first due
- [ ] Three topics give three times the throughput
> Pausing a partition on its head is only correct when nothing behind the head is due earlier. Equal delays per topic make that true by construction.
:::

# Why a sleep blocks everything behind it

A consumer group member is assigned partitions, and one \`poll\` loop serves all of them. The loop is
the only thread that reads: if it sleeps for five seconds because the record under its cursor is not
due, nothing on **any** of its partitions is handled for five seconds — the main topic's records
included. With a 5-minute tier that is a 5-minute outage of the worker per retried record:

:::sequence
{
  "participants": ["tasks", "tasks.retry.5m", "naive worker", "handler"],
  "messages": [
    {"from": "tasks.retry.5m", "to": "naive worker", "label": "poll → key a, not_before = now + 300 000", "kind": "reply"},
    {"from": "naive worker", "to": "naive worker", "label": "sleep(300 000) — the loop is the only reader", "kind": "sync"},
    {"from": "tasks", "to": "naive worker", "label": "keys b, c, d … queue up unread for five minutes", "kind": "async"},
    {"from": "naive worker", "to": "handler", "label": "handler(\\"a\\", …) — finally", "kind": "sync"},
    {"from": "naive worker", "to": "handler", "label": "handler(\\"b\\", …) — five minutes late for no reason", "kind": "sync"}
  ]
}
:::

Two things go wrong at once:

- **Head-of-line blocking across topics.** One retried record delays every fresh record. In a
  pipeline where retries are 1% of traffic, a sleeping loop spends almost all of its time waiting.
- **The group thinks the member is dead.** A loop that does not call \`poll\` within
  \`max.poll.interval.ms\` (five minutes by default) is removed from the group and its partitions are
  reassigned — in the middle of its sleep, to a member that will read the same record and sleep too.

The other shortcut, skipping the record and committing past it, keeps the loop moving by **losing the
record**: the commit says "handled" about work that was never done, and no replay will find it.

> A delay has to cost the partition that owns the delayed record, and nothing else. That rules out
> the consumer's thread, which owns every partition.

:::quiz
Q: A worker owns three partitions of \`tasks\` and one of \`tasks.retry.5m\`. It sleeps until a retry record is due. What happens to the \`tasks\` partitions?
- [x] Nothing is read from them for five minutes, and the group may evict the member for not polling
- [ ] They are served by the other threads of the consumer
- [ ] Kafka reassigns them to another member immediately, with no loss
> A Kafka consumer is single-threaded by design; its one poll loop serves every assigned partition. Blocking it is blocking all of them, and exceeding the poll interval turns the stall into a rebalance.
:::

# Pause, seek back, resume

The consumer API has the tool for exactly this: \`pause(partitions)\` tells the fetcher to stop
returning records from those partitions while \`poll\` keeps serving the rest and keeps the member
alive in the group; \`resume\` undoes it. One detail makes it correct: by the time the loop sees the
record, the consumer's position has already moved **past** it, so a plain pause would resume at the
*next* record and the delayed one would be silently skipped. Hence the three-part dance:

:::sequence
{
  "participants": ["tasks", "tasks.retry.5s", "worker", "handler"],
  "messages": [
    {"from": "tasks.retry.5s", "to": "worker", "label": "poll → key a at offset 17, not_before = now + 5 000", "kind": "reply"},
    {"from": "worker", "to": "tasks.retry.5s", "label": "pause(tasks.retry.5s[p]) · seek(p, 17) — no commit", "kind": "sync"},
    {"from": "worker", "to": "worker", "label": "paused[(tasks.retry.5s, p)] = (not_before, 17)", "kind": "sync"},
    {"from": "tasks", "to": "worker", "label": "poll → keys b, c — still flowing", "kind": "reply"},
    {"from": "worker", "to": "handler", "label": "handler(\\"b\\", …) · handler(\\"c\\", …) · commit each", "kind": "sync"},
    {"from": "worker", "to": "tasks.retry.5s", "label": "now ≥ not_before: resume(tasks.retry.5s[p]) · drop from the map", "kind": "sync"},
    {"from": "tasks.retry.5s", "to": "worker", "label": "poll → the same record, offset 17", "kind": "reply"},
    {"from": "worker", "to": "handler", "label": "handler(\\"a\\", \\"job-a\\") — like any other record", "kind": "sync"}
  ]
}
:::

- **Pause** the record's partition. Only that partition stops; the main topic and every other
  partition — including other partitions of the same retry topic — keep flowing.
- **Seek** the partition back to the record's offset, so that the first record read after \`resume\`
  is the one that waited, not the one after it.
- **Remember** \`(topic, partition) → (not_before, offset)\` in a map. Nothing is committed: the record
  is still outstanding.
- **Move on.** At the top of every loop turn (or on a timer), walk the map; every entry whose time has
  come is resumed and dropped from the map. The clock moves because other handlers run, never because
  the loop waits.

Why the seek is not optional: the offset \`poll\` hands back is the position of the *next* fetch. Pause
alone freezes that position at 18; resume then delivers 18 and the record at 17 is never handled,
although it was never committed either — until a restart replays it, by luck. Seeking to 17 makes
the behaviour deterministic.

Why nothing is committed while a record waits: the offset is the record of what was done. If the
worker crashes during the pause, the new owner of the partition starts from the last commit, reads
the same record, sees the same \`not_before\`, and pauses again. Nothing was done, so nothing is lost
and nothing is duplicated.

:::quiz
Q: On a record that is not due, the worker pauses the partition and later resumes it — but forgets to seek. What does the handler see after the resume?
- [ ] The same record, because the pause froze the cursor on it
- [x] The record after it; the delayed record was already behind the cursor when the loop saw it and is skipped
- [ ] An error from the consumer, since the partition was paused mid-record
> poll advances the position past what it returns. Pause stops further fetches but does not rewind; only seek puts the delayed record back under the cursor so that resume delivers it.
:::

# Hand-off before commit, and the end of the line

A retry topic is a second copy of the record. The moment the worker commits the source offset, the
original is gone from its point of view; if the copy did not make it, the record is lost — the same
loss as skipping, by a longer route. So the order on every failure is fixed:

:::sequence
{
  "participants": ["tasks", "worker", "handler", "tasks.retry.5s"],
  "messages": [
    {"from": "tasks", "to": "worker", "label": "poll → key a", "kind": "reply"},
    {"from": "worker", "to": "handler", "label": "handler(\\"a\\", \\"job-a\\")", "kind": "sync"},
    {"from": "handler", "to": "worker", "label": "raises \\"boom\\"", "kind": "reply"},
    {"from": "worker", "to": "tasks.retry.5s", "label": "produce key a · attempt=1 · error=boom · not_before=now+5000 · flush", "kind": "sync"},
    {"from": "tasks.retry.5s", "to": "worker", "label": "ack (acks=all)", "kind": "reply"},
    {"from": "worker", "to": "tasks", "label": "commit offset — only now", "kind": "sync"}
  ]
}
:::

- **Produce, then flush or await, then commit.** \`acks=all\` means the retry record is on the
  replicas before the broker answers. A hand-off that was not acknowledged is not committed; a crash
  in between replays the original, and the dependency gets one more attempt than planned, which is
  the cheap side of the trade.
- **Success commits synchronously.** Every record the loop handles, on any of the four topics, ends
  with its offset committed — a retry that succeeds is simply handled and committed, with nothing new
  produced anywhere.
- **The dead-letter topic ends it.** After the last tier, \`tasks.dlq\` gets the record with \`attempt\`
  \`4\` and \`error\`, no \`not_before\`; the worker does not consume it. Someone — or a replayer, once the
  dependency is healthy — puts it back on \`tasks\`.

This is the standard
[at-least-once](https://kafka.apache.org/documentation/#semantics) arrangement: commit after the
side effect, accept a duplicate on a crash. The side effect here is a produce, which is why the
flush sits between the handler's failure and the commit.

:::widget delivery-semantics {}

Real systems add what the drill leaves out: rebalance handling, so that a paused partition that is
revoked is forgotten and the new owner pauses it again from the committed offset; a cap on how long a
pause may last before the record is moved on; per-tier consumer groups, so a slow tier cannot
starve the main loop's poll interval; and a dead-letter replayer.

:::quiz
Q: The worker produces the retry record, commits the source offset, and only then waits for the broker's acknowledgement. The broker was briefly unreachable. What is the outcome?
- [ ] The retry record is delivered late, after the broker returns
- [x] The source offset says "handled", the retry topic has nothing — the record is lost
- [ ] The consumer refuses the commit because a send is in flight
> A commit is a statement that the record needs no further work. Making it before the copy is safely on the retry topic turns a broker hiccup into a silent loss. Flush first, commit second — every time.
:::

# What to take away

- **Kafka has no delayed delivery; a delay is data.** A topic named for the delay and a \`not_before\`
  header in epoch milliseconds make the wait durable, visible and free of threads.
- **One topic per tier, because a tier's head is always the first due.** Mixed delays in one topic
  recreate head-of-line blocking inside the retry path.
- **Never sleep the consumer and never commit past a record.** The first stalls every partition the
  member owns and risks eviction from the group; the second loses the record.
- **Pause, seek back, remember, resume.** The partition pays for the delay, nothing else does; the
  seek is what makes \`resume\` deliver the record that waited.
- **Flush the hand-off before committing the source.** The retry record is the only copy once the
  offset moves; after the last tier that copy goes to \`tasks.dlq\` for a human or a replayer.

The primary reference is Uber's
[*Building Reliable Reprocessing and Dead Letter Queues with Apache Kafka*](https://www.uber.com/blog/reliable-reprocessing/):
the retry-topic ladder, the dead-letter topic and the reasoning against blocking retries, from the
team that ran it for payments; Spring Kafka's
[non-blocking retry topics](https://docs.spring.io/spring-kafka/reference/retrytopic.html) document
the same design as a library.
`;
