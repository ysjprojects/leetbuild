/**
 * The learning guide for the retry-topic / dead-letter drill: the mechanism, where it comes from,
 * the failure it prevents and the one line that makes it safe — a figure or a demo where one says it
 * faster than prose, a pop quiz per concept section.
 * Rendered at `/kafka-retry-dlq/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A Kafka partition is a queue with one head. A consumer that cannot process the record at the head has
two choices: retry in place and stall everything behind it, or move the failure **sideways** onto
another topic and carry on. The retry topic and the dead letter are that sideways move, and the drill
implements the whole of it in one consumer loop:

:::diagram
{
  "nodes": [
    {"id": "fulfilment", "kind": "service", "label": "fulfilment", "sub": "run(handler) · group fulfilment · auto-commit off", "x": 25, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "Kafka", "sub": "orders · orders.retry · orders.dlq", "x": 70, "y": 50}
  ],
  "edges": [
    {"from": "kafka", "to": "fulfilment", "kind": "kafka", "label": "consume orders · orders.retry"},
    {"from": "fulfilment", "to": "kafka", "kind": "kafka", "label": "hand-off (attempt, error) · acks=all · commit"}
  ]
}
:::

The contract, in one line per rule:

- \`run(handler)\` joins group \`fulfilment\`, subscribes to \`orders\` and \`orders.retry\`, auto-commit off,
  and calls \`handler(event)\` with the parsed JSON of every record.
- The handler raises → the record is re-produced, **same key, same value**, with headers \`attempt\` (the new
  count, a decimal string) and \`error\` (the exception's message).
- Destination: \`orders.retry\` while \`attempt + 1 < MAX_ATTEMPTS\` (\`MAX_ATTEMPTS = 3\`), else \`orders.dlq\`.
- A value that is not JSON skips the handler and goes straight to \`orders.dlq\`.
- The hand-off is **acknowledged** (\`flush\` / await \`send\`, \`acks=all\`) before the source offset is committed;
  an unacknowledged hand-off is not committed — the record is redelivered instead.
- Every record the loop handles ends with its offset committed, synchronously.

Uber's payments platform described the pattern in
[*Building Reliable Reprocessing and Dead Letter Queues with Apache Kafka*](https://www.uber.com/blog/reliable-reprocessing/);
Spring Kafka's \`DeadLetterPublishingRecoverer\` and Kafka Connect's \`errors.deadletterqueue\` package the
same moves.

# Why a failing record must not block its partition

Offsets are the whole of a consumer's state: a group's position in a partition is one integer, and a
record is "done" when the integer moves past it. That is what makes a poison record expensive — the
loop cannot skip it without saying so, and retrying it in place means the integer never moves:

:::sequence
{
  "participants": ["Kafka", "fulfilment", "handler"],
  "messages": [
    {"from": "Kafka", "to": "fulfilment", "label": "poll → orders p3 offset 41 (key order-7)", "kind": "reply"},
    {"from": "fulfilment", "to": "handler", "label": "handler(event)", "kind": "sync"},
    {"from": "handler", "to": "fulfilment", "label": "raises \\"warehouse down\\"", "kind": "reply"},
    {"from": "fulfilment", "to": "handler", "label": "handler(event) again — sleep, retry", "kind": "sync"},
    {"from": "handler", "to": "fulfilment", "label": "raises again", "kind": "reply"},
    {"from": "fulfilment", "to": "fulfilment", "label": "offset 41 never committed; offsets 42…9000 wait behind it", "kind": "sync"},
    {"from": "Kafka", "to": "fulfilment", "label": "max.poll.interval exceeded → kicked from the group → rebalance → offset 41 again", "kind": "reply"}
  ]
}
:::

One bad order has stopped every order that hashed to the same partition, and the broker's own
liveness check makes it worse: a consumer that spends too long between polls is thrown out of the
group, the partition is reassigned, and the next member starts at the same offset. The options:

| Strategy | What happens to the bad record | What happens to the records behind it |
| --- | --- | --- |
| Retry in place | tried forever, or until the handler is fixed | wait; the partition's lag grows without bound |
| Skip and commit | lost, silently | flow |
| Re-produce to a retry topic, commit | tried again later, from another queue | flow |
| Re-produce to a dead-letter topic, commit | kept, with the reason, for a human or a replay tool | flow |

The last two are the drill. The source partition pays one produce and one commit per failure — the same
cost as a success — and the problem record becomes ordinary data on another topic.

:::quiz
Q: The warehouse service is down for twenty minutes. What does a consumer that retries in place do to a partition of 9,000 pending orders?
- [ ] Processes the other 8,999 and comes back to the failed one
- [x] Stalls all 9,000 behind the one at the head, and is likely thrown out of the group for not polling
- [ ] Commits past the failed record after a timeout
> A partition has one head. Nothing behind it is reachable until the offset moves, and a loop that sleeps and retries stops polling — which the broker reads as death. Moving the failure sideways costs one produce; stalling costs the whole line.
:::

# The retry topic and the attempt header

A retry record is the source record with two headers added. The value is never rewritten — a downstream
reader of \`orders.retry\` sees exactly the order the producer sent — and the bookkeeping lives beside it:

\`\`\`text
topic   orders.retry
key     order-7                      ← same as the source record
value   {"order_id": "order-7", …}   ← same bytes as the source record
headers attempt = "1"                ← decimal string: the failures so far, including this one
        error   = "warehouse down"   ← the exception's message
\`\`\`

The consumer reads \`attempt\` back as an integer; a record without the header — anything fresh from
\`orders\` — is at attempt 0. On a failure the record is at \`attempt + 1\`, and that number picks the
destination:

| Record arrives from | \`attempt\` header | Handler raises → new count | \`new < MAX_ATTEMPTS\` (3)? | Goes to |
| --- | --- | --- | --- | --- |
| \`orders\` | none (0) | 1 | yes | \`orders.retry\` with \`attempt = "1"\` |
| \`orders.retry\` | \`"1"\` | 2 | yes | \`orders.retry\` with \`attempt = "2"\` |
| \`orders.retry\` | \`"2"\` | 3 | no | \`orders.dlq\` with \`attempt = "3"\` |

Three facts about the loop fall out of the table:

- **One consumer, two subscriptions.** The retry topic is consumed by the same \`run\` with the same
  handler; the only thing that distinguishes a retry from a first try is the header.
- **One hand-off function.** Topic, source record, new count, error text → produce with the source's
  key and value, wait for the ack, raise if delivery failed. Retry and dead letter differ only in the
  topic name.
- **The handler is called exactly three times** for a record that never succeeds: once from \`orders\`,
  twice from \`orders.retry\`. The third failure is the one that dead-letters it.

:::details Why a header rather than a field in the value
The value belongs to the producer's schema; the attempt count belongs to the consumer's bookkeeping.
Writing \`attempt\` into the JSON would mean every retry topic carries a different schema from its
source, that a replay tool must strip it before re-injecting, and that a value which is *not* JSON
(the poison case below) has nowhere to put it. Headers were added in Kafka 0.11 for exactly this kind
of metadata; Uber's post uses them the same way. Real systems also bound the header's size, so an
exception message with a stack trace in it cannot push the record past the broker's message limit.
:::

:::quiz
Q: A record from \`orders.retry\` arrives with \`attempt = "2"\` and the handler raises again. Where does it go?
- [ ] \`orders.retry\` with \`attempt = "3"\` — it has one more try
- [x] \`orders.dlq\` with \`attempt = "3"\` — three failures is \`MAX_ATTEMPTS\`
- [ ] Nowhere; the offset is committed and the record dropped
> This failure makes the count 3, and \`3 < 3\` is false. The record has had its first try and two retries; the third failure is the cut-off, and the dead letter keeps it rather than dropping it.
:::

# The dead-letter topic

A dead letter is a record the pipeline has given up on **without losing it**. It sits on \`orders.dlq\`
with the same key and value it always had, plus the two headers that explain why it is there:

\`\`\`text
topic   orders.dlq
key     order-7
value   {"order_id": "order-7", …}
headers attempt = "3"
        error   = "warehouse down"
\`\`\`

Two roads lead there:

| Case | Handler called? | \`attempt\` on the dead letter | \`error\` on the dead letter |
| --- | --- | --- | --- |
| Third failure of a well-formed record | yes, three times in all | \`"3"\` | the handler's exception message |
| Value that is not JSON | **never** | its count + 1 (\`"1"\` for a fresh record) | the parse error |

The second row is the **poison** case, and it is the one that justifies a dead letter on its own.
A value that cannot be parsed will not parse better in a minute; retrying it is three guaranteed
failures that delay a verdict the consumer already knows. So the loop dead-letters it on sight, with
the parse error as the reason, and commits — the handler never sees it.

What the dead letter is *for*:

- **Debuggable without logs.** The \`error\` header says what went wrong; the value says to what. An
  engineer reading the topic has the whole story in one record.
- **Replayable.** A DLQ consumer — left out of the drill, present in every production system — reads
  the record, decides it was transient after all, and produces it back to \`orders\` with the headers
  stripped. Same key, so it rejoins its partition.
- **Alertable.** The topic's rate is the pipeline's failure rate; a non-zero lag on \`orders.dlq\` is a
  page.

Uber's design adds a **delay** between tiers that the drill leaves out: \`retry.5s\`, \`retry.1m\`, \`retry.10m\`,
each consumed only once its records are due, so a dependency gets time to recover before the next
try. Spring Kafka pauses the partition until a record's due time instead. Either way the shape is
the same: topics as queues, headers as state, one dead letter at the end.

:::quiz
Q: A record arrives on \`orders\` whose value is \`not json at all\`. What should the loop do?
- [ ] Call the handler with the raw string and let it decide
- [ ] Send it to \`orders.retry\` with \`attempt = "1"\`; it may parse next time
- [x] Send it to \`orders.dlq\` with \`attempt = "1"\` and the parse error, never calling the handler, and commit
> Bytes do not change on retry. Three guaranteed failures on \`orders.retry\` would only delay the dead letter and add noise; dead-lettering on first sight keeps the record, records why, and frees the partition at once.
:::

# Flush before commit: the loss, drawn

The hand-off is a produce to one topic followed by a commit on another, and the two are not atomic.
The order they happen in, and whether the loop *waits* between them, decides whether a slow broker
costs you a record. The producer buffers sends and acknowledges later; a commit that does not wait
for that acknowledgement is a promise the loop cannot keep:

:::sequence
{
  "participants": ["Kafka", "fulfilment", "producer buffer"],
  "messages": [
    {"from": "Kafka", "to": "fulfilment", "label": "poll → orders offset 41 (key order-7)", "kind": "reply"},
    {"from": "fulfilment", "to": "fulfilment", "label": "handler raises \\"warehouse down\\"", "kind": "sync"},
    {"from": "fulfilment", "to": "producer buffer", "label": "produce orders.retry — buffered, not yet sent", "kind": "async"},
    {"from": "fulfilment", "to": "Kafka", "label": "commit orders offset 42 — no wait", "kind": "sync"},
    {"from": "Kafka", "to": "fulfilment", "label": "committed", "kind": "reply"},
    {"from": "producer buffer", "to": "Kafka", "label": "send orders.retry … broker stalled 5 s", "kind": "async"},
    {"from": "fulfilment", "to": "fulfilment", "label": "process crashes / rebalance", "kind": "sync"},
    {"from": "Kafka", "to": "fulfilment", "label": "next member starts at offset 42 — order-7 is on no topic", "kind": "reply"}
  ]
}
:::

The source says the record is dealt with; the retry topic never received it. That is
[at-most-once](https://kafka.apache.org/documentation/#semantics) delivery, arrived at by accident.
The correct loop puts the wait between the two:

:::sequence
{
  "participants": ["Kafka", "fulfilment", "producer"],
  "messages": [
    {"from": "Kafka", "to": "fulfilment", "label": "poll → orders offset 41 (key order-7)", "kind": "reply"},
    {"from": "fulfilment", "to": "fulfilment", "label": "handler raises \\"warehouse down\\"", "kind": "sync"},
    {"from": "fulfilment", "to": "producer", "label": "produce orders.retry (key order-7, attempt=1, error=…)", "kind": "sync"},
    {"from": "producer", "to": "Kafka", "label": "send · acks=all", "kind": "sync"},
    {"from": "Kafka", "to": "producer", "label": "ack — after the 5 s stall, once every in-sync replica has it", "kind": "reply"},
    {"from": "producer", "to": "fulfilment", "label": "flush returns / send resolves", "kind": "reply"},
    {"from": "fulfilment", "to": "Kafka", "label": "commit orders offset 42 (sync)", "kind": "sync"},
    {"from": "Kafka", "to": "fulfilment", "label": "committed", "kind": "reply"}
  ]
}
:::

The rules the drill holds the loop to:

- **Produce, wait, commit — in that order, on every path.** \`flush\` in librdkafka, \`await send\` in
  KafkaJS, \`.get()\` on the future in the Java client; \`acks=all\` so the ack means every in-sync
  replica has the record, not one broker's page cache.
- **No ack, no commit.** If the hand-off fails or times out, raise. The source offset stays where it
  was and the record is redelivered — a duplicate attempt, which the handler can see coming, rather
  than a loss, which nobody can.
- **Auto-commit off.** The client's periodic commit would move the offset on a timer, regardless of
  what the loop had finished; every commit here is explicit and synchronous, per record.
- **Success commits too.** A handled record from \`orders\` or \`orders.retry\` ends with its offset
  committed; the group's lag on both topics is zero when the loop is caught up.

:::widget delivery-semantics {}

The same shape as any consume-transform-produce loop: the output must be durable before the input is
acknowledged. What the drill leaves out — and real systems add — is batching those commits so the
sync wait is paid once per poll rather than once per record.

:::quiz
Q: The loop produces the retry record, commits the source offset immediately, and the broker hosting \`orders.retry\` stalls for 5 s before the process is restarted. What is the state afterwards?
- [ ] The retry record is on \`orders.retry\` and the source is committed — correct
- [x] The source is committed and the retry record is nowhere: the order is lost
- [ ] The source is uncommitted, so the record is redelivered and retried twice
> The commit was a promise made before the produce was acknowledged. The process died with the record still in the producer's buffer; the next member of the group starts past it. Waiting for the ack first is the only thing that turns this into a redelivery rather than a loss.
:::

# The key travels with the record

Partitioning is by key: every record keyed \`order-7\` lands on one partition of a topic, in the order
it was produced. The hand-off keeps the source key for the same reason the source producer set it:

- A customer's orders — create, pay, ship — hash to one partition of \`orders.retry\` and are retried in
  order, by one consumer, rather than scattered across partitions and reordered.
- A replay from \`orders.dlq\` back to \`orders\` rejoins its original partition without a lookup.
- The value is untouched, so anything that keys on a field inside it still agrees with the header.

:::widget kafka-partitions {"partitions": 4}

Dropping the key — producing with \`key = null\` — would round-robin retry records across partitions:
two retries of related orders would race each other on different consumers, and the one guarantee a
keyed topic offers, [per-key ordering](https://kafka.apache.org/documentation/#intro_concepts_and_terms),
would be lost at exactly the moment the data is already in trouble.

:::quiz
Q: Why must the retry record carry the source record's key rather than none?
- [x] So related records stay on one partition of the retry topic, in order, and a replay rejoins the original partition
- [ ] So the broker can deduplicate the retry against the source
- [ ] Because a record without a key cannot carry headers
> Keys choose partitions; partitions give order. A null key round-robins the retries, and two retries of one customer's orders can then be processed concurrently and out of order. The broker never deduplicates by key, and headers are independent of it.
:::

# What to take away

- **Move failures sideways, never retry in place.** A partition has one head; re-producing the failed
  record costs one produce, stalling costs every record behind it and, soon, the group membership.
- **State in headers, value untouched.** \`attempt\` and \`error\` travel beside the bytes, so the retry
  topic has the source's schema and the dead letter explains itself.
- **A bounded ladder ends in a dead letter.** \`attempt + 1 < MAX_ATTEMPTS\` picks \`orders.retry\`, else
  \`orders.dlq\`; a value that will never parse skips the ladder.
- **Ack, then commit.** The source offset is a promise that the record is dealt with; it is only true
  once the hand-off is durably on the next topic. Produce-then-commit without the wait is at-most-once.
- **Keep the key.** Same partition, same order, same route home on replay.

The primary reference is Uber's
[*Building Reliable Reprocessing and Dead Letter Queues with Apache Kafka*](https://www.uber.com/blog/reliable-reprocessing/)
(Ning Xia, 2018): the retry-topic ladder, the headers, and the dead letter as a payments team ran them,
with the delays and the DLQ consumer the drill leaves out.
`;
