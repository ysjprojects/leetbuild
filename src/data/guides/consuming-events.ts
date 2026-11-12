import type {Source} from '@/lib/types';

export const guide = `# The failure mode

A consumer reads a record, does something with it (adds tokens to a bill, folds a sample into a
score, queues a job) and tells the broker it is done by committing the offset. Kafka delivers
**at least once**: the only thing it remembers about your progress is the committed offset, and it
knows nothing about Redis, your database or the job queue. So every consumer has to answer two
questions, and most broken ones answer neither:

1. **Where does the commit sit relative to the effect?** Commit first and a crash in between loses
   the record for good. Effect first and a crash in between replays it.
2. **What happens when a record arrives twice?** It will: after a crash, after a rebalance, after a
   producer retry, after someone rewinds the group to rebuild a total. If the effect is not safe to
   apply twice, every one of those counts double.

The smallest instance is a billing consumer:

\`\`\`python
msg = consumer.poll(1.0)
consumer.commit(message=msg, asynchronous=False)   # "done"
event = json.loads(msg.value())
redis.hincrby(f"usage:{event['tenant']}:{event['day']}", "tokens", event["tokens"])
\`\`\`

It runs, the demo bill moves, and the code reads well. A crash (a deploy, an OOM kill, a lost
container) between the second and fourth lines bills nothing for that request, and nobody can ever
find out: the offset says the record was handled, and the producer will never send it again. Swap
the two lines and the loss turns into a double charge on every replay. The fix is the pair: effect
before the commit, **and** an effect that a second delivery cannot repeat.

# How it shows up

The debugging courses hide this in consumers that look finished:

- [LLM Gateway: one usage event per request, billed once](/ai-gateway/5-usage-events): a billing
  consumer whose totals are right in the demo and wrong after the first crash.
- [Batch Inference: a coordinator that folds once](/batch-inference/4-events): a coordinator that
  folds shard results into batch totals, where a crash loses a shard and a replay counts one twice.
- [RAG Service: the eval gate](/rag-service/5-eval-gate): an eval consumer that decides whether a
  release ships, counting samples that a crash can drop.
- [Experiment Platform: exposure events](/experiments-platform/4-events): exposure counts that
  drift from the units actually exposed.
- [Eval Harness: run progress in Redis](/eval-harness/2-state): progress counters fed from an
  at-least-once topic, where a rebalance hands the same sample to a second worker.
- [Data Classification: one job per new schema](/data-classification/1-scan-requests) and
  [Catalog Enrichment: SKU intake](/catalog-enrichment/1-sku-intake): intake consumers where one
  malformed event, or one unchanged one, does more damage than it should.

The symptoms rhyme. Totals that are exact in a demo with no failures. A count that is slightly low
after an incident, or slightly high after a rebalance. A partition whose lag stops moving because the
same record crashes the consumer on every restart. A job queued twice for the same input. None of
them reproduce without injecting the failure, which is why they survive review.

# The mechanism

## Offsets are the only memory

A partition is an append-only log, and a consumer group stores one number per partition: the
**committed offset**, the offset of the next record to read. On startup, and whenever a partition
moves to a new member, consumption resumes from that number. Anything polled but not committed is
read again; anything committed is never read again by that group.

:::sequence
{
  "participants": ["Kafka", "billing (member A)", "Redis"],
  "messages": [
    {"from": "Kafka", "to": "billing (member A)", "label": "poll -> usage, partition 3, offset 1041", "kind": "reply"},
    {"from": "billing (member A)", "to": "Redis", "label": "HINCRBY usage:acme:20261112 tokens 812", "kind": "sync"},
    {"from": "Redis", "to": "billing (member A)", "label": "(integer) 40318", "kind": "reply"},
    {"from": "billing (member A)", "to": "billing (member A)", "label": "killed before the commit", "kind": "sync"},
    {"from": "Kafka", "to": "billing (member A)", "label": "restart: committed offset is still 1041 -> offset 1041 again", "kind": "reply"},
    {"from": "billing (member A)", "to": "Redis", "label": "HINCRBY ... 812 (a second time)", "kind": "sync"}
  ]
}
:::

Kafka did exactly what it promised. The duplicate is the price of not losing the record, and it is
the consumer's job to make the second application harmless.

## Where duplicates come from

| Source | What happens | Same offset? |
| --- | --- | --- |
| Crash between effect and commit | the restarted member reads from the last committed offset | yes |
| Rebalance | a member joins, leaves, or misses \`max.poll.interval.ms\`; its partitions move with their uncommitted records | yes |
| Slow member kicked out | the old member is still applying a record while the new owner applies it too, at the same time | yes |
| Producer retry without idempotence | a lost ack makes the producer send again; the log holds two copies | **no**, two offsets |
| Replay | an operator resets the group's offsets to rebuild state, or a new group reads from \`earliest\` | yes, much later |

Two lessons hide in that table. A dedupe keyed by \`(partition, offset)\` catches the first rows and
misses producer duplicates: dedupe by an **event id** the producer put in the payload. And a
duplicate can arrive **concurrently**, in another process, so a check followed by a separate write
is a race: the check and the effect have to be one atomic step.

## Auto-commit is not "commit after processing"

Each client commits automatically by default, and each one means something slightly different:

- **Java \`KafkaConsumer\`** commits, on a timer, the offsets returned by the previous \`poll()\`. That is
  at-least-once only if every record from a poll is finished before the next poll. Hand records to a
  thread pool and the commit runs ahead of the work.
- **librdkafka (and confluent-kafka for Python, which wraps it)** commits on a background timer
  whatever offset is *stored*, and by default (\`enable.auto.offset.store=true\`) an offset is stored
  the moment the message is handed to you. A crash mid-effect can lose a record that was committed
  before you finished it.
- **kafkajs** \`eachMessage\` resolves the offset when your handler's promise settles. Await the
  effect and that is at-least-once; fire it without awaiting and it is not.
- **kafka-go** \`ReadMessage\` on a reader with a \`GroupID\` commits as it reads. \`FetchMessage\` does not.

The rule is simpler than the configuration matrix: turn auto-commit off (or turn off the automatic
offset store) and commit explicitly, after the effect has returned.

:::widget delivery-semantics {}

:::quiz
Q: A consumer has \`enable.auto.commit=false\`, polls a record, commits its offset synchronously and then writes the effect to Redis. Which outcome does a crash between the two lines produce?
- [ ] The record is redelivered and the effect is applied once
- [x] The record is never applied: the group has moved past it and no one sends it again
- [ ] The record is applied twice
- [ ] Kafka notices the missing effect and rolls the commit back
> Turning auto-commit off only moves the decision into your code; it does not make the decision right. Committing before the effect is at-most-once, whoever triggers the commit. The commit belongs after the effect, and the effect then has to tolerate the replay.
:::

## Consumer groups and partition assignment

A group spreads a topic's partitions over its members: each partition has exactly one owner at a
time, so records with the same key are applied in order by one process. Members beyond the partition
count sit idle. When membership changes, the group **rebalances**: partitions are revoked from some
members and assigned to others, and the new owner starts from the committed offset.

:::widget consumer-groups {"partitions": 6}

Three consequences for correctness:

- **Uncommitted work moves.** Whatever a member applied but had not committed when its partition was
  revoked is applied again by the next owner. Commit what is finished in the revoke callback
  (\`on_revoke\`, \`onPartitionsRevoked\`, the \`GROUP_JOIN\`/rebalance hooks) so the replay is short.
- **A slow member is a dead member.** If processing a poll takes longer than \`max.poll.interval.ms\`,
  the coordinator removes the member and reassigns its partitions while it is still working. For a
  while two processes apply the same records; only an atomic dedupe keeps that harmless.
- **Ordering is per partition, not per topic.** A total that depends on order (a status machine, the
  latest version wins) is safe only if the producer keyed related events to one partition.

## Poison records

A record that can never be processed (bad JSON, a missing field, an unknown version) is not a
transient failure. If the consumer throws and does not commit, it restarts, reads the same offset and
throws again: the partition stops while its lag grows, and every record behind the bad one waits. If
the consumer catches the error and commits silently, the record vanishes. The middle path is a
**dead-letter topic**: produce the original key and bytes, plus the reason, wait for that produce to
be acknowledged, then commit and move on.

The distinction that matters is permanent versus transient. Redis being down is not a poison record:
dead-lettering it throws away good data. A transient failure is retried (or the partition paused)
without committing; only a record that will fail the same way forever goes to the dead-letter topic.

:::quiz
Q: The effect store (Redis) times out for 20 seconds during a failover. What should the consumer do with the records it polls in that window?
- [ ] Send them to the dead-letter topic and commit, so the partition keeps moving
- [ ] Log the error and commit, since Redis will catch up later
- [x] Retry or pause without committing, so the records are applied once Redis is back
- [ ] Skip them and reset the group to earliest afterwards
> A dead-letter topic is for records that will fail the same way forever. A store outage is transient: committing past those records, or dead-lettering valid data, turns a 20-second blip into permanent loss. Pausing the partition or retrying with backoff keeps the offset behind the effect.
:::

# The fix and its trade-offs

## 1. Effect, then commit, explicitly

**Python (confluent-kafka):**

\`\`\`python
consumer = Consumer({
    "bootstrap.servers": BROKERS,
    "group.id": "billing",
    "enable.auto.commit": False,
    "auto.offset.reset": "earliest",
})
consumer.subscribe(["usage"])
while running:
    msg = consumer.poll(1.0)
    if msg is None or msg.error():
        continue
    apply_once(msg)                                   # the effect, idempotent
    consumer.commit(message=msg, asynchronous=False)  # then the commit
\`\`\`

**TypeScript (kafkajs):**

\`\`\`ts
await consumer.run({
  autoCommit: false,
  eachMessage: async ({topic, partition, message}) => {
    await applyOnce(message);
    // the committed offset is the next one to read
    const next = (BigInt(message.offset) + 1n).toString();
    await consumer.commitOffsets([{topic, partition, offset: next}]);
  },
});
\`\`\`

**Go (kafka-go):**

\`\`\`go
r := kafka.NewReader(kafka.ReaderConfig{Brokers: brokers, GroupID: "billing", Topic: "usage"})
for {
    m, err := r.FetchMessage(ctx) // not ReadMessage: that commits on read
    if err != nil {
        return err
    }
    if err := applyOnce(ctx, m); err != nil {
        return err // no commit: the record comes back
    }
    if err := r.CommitMessages(ctx, m); err != nil {
        return err
    }
}
\`\`\`

**C (librdkafka):**

\`\`\`c
rd_kafka_conf_set(conf, "enable.auto.commit", "false", errstr, sizeof errstr);
/* ... create the consumer, subscribe ... */
rd_kafka_message_t *m = rd_kafka_consumer_poll(rk, 1000);
if (m && !m->err && apply_once(m) == 0)
    rd_kafka_commit_message(rk, m, 0); /* 0: synchronous */
if (m)
    rd_kafka_message_destroy(m);
\`\`\`

With librdkafka-based clients, a common alternative keeps the background auto-commit but sets
\`enable.auto.offset.store=false\` and calls \`store_offsets\` / \`rd_kafka_offsets_store\` after the
effect: the timer then only ever commits finished work, without a broker round trip per record.

Trade-offs: a synchronous commit per record costs a round trip each. Committing once per poll batch,
after every record in it is applied, is the usual compromise; the price is a longer replay after a
crash, which an idempotent effect absorbs. If records are processed concurrently, commit only the
highest offset below which **everything** is done: committing 1045 while 1043 is still in flight
loses 1043 if the process dies.

## 2. Make the effect safe to apply twice

Commit-after-effect turns loss into duplicates; the effect has to turn duplicates into nothing. The
rule: **record that the event was applied in the same atomic step as the effect**.

For a Redis counter, a processed-id set and the increment in one script:

\`\`\`lua
-- KEYS[1] processed ids   KEYS[2] totals hash
-- ARGV[1] event id   ARGV[2] field   ARGV[3] amount   ARGV[4] ttl seconds
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then
  return 0                          -- seen before: apply nothing
end
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('HINCRBY', KEYS[2], ARGV[2], ARGV[3])
return 1
\`\`\`

The script runs atomically, so two members holding the same record during a rebalance cannot both
pass the \`SADD\`. Splitting it into \`SISMEMBER\`, then \`HINCRBY\`, then \`SADD\` reopens exactly that
race, and a crash between the increment and the mark brings the double count back.

For a SQL store, the same idea is a unique constraint in the transaction that applies the effect:

\`\`\`sql
BEGIN;
INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING;
-- apply the effect only if that insert affected one row
COMMIT;
\`\`\`

A third option stores the consumed offset itself in the same transaction as the effect and seeks to
it on assignment, ignoring Kafka's committed offset. It is exact, but it dedupes by offset, so it
does not catch producer duplicates, and every partition assignment now needs a seek.

Trade-offs and choices:

- **What is the event id?** One the producer assigns once per logical event (a request id, a sample
  id, \`batch_id:shard_id\`), not a fresh UUID per send and not the offset. Getting this wrong makes
  the dedupe a no-op.
- **How long are ids kept?** At least as long as a duplicate can arrive: the topic's retention if
  replays from \`earliest\` are possible, else a window comfortably past the longest outage. Scope the
  set to the thing it guards (\`processed:{run_id}\`, a set per day) so it expires with its totals; the
  [keys and expiry guide](/guides/keys-and-expiry) covers the scoping.
- **Naturally idempotent effects need no set.** \`HSET entry:{shard} ...\`, an upsert by primary key, or
  "set status to delivered if the version is newer" are safe to repeat. Increments, appends and
  queued jobs are not.
- **Kafka transactions** give exactly-once for consume-transform-produce **within Kafka**: the output
  records and the input offsets commit together. They do nothing for an effect in Redis or Postgres.

:::details Folding a replay once: totals derived from entries
When a consumer folds results into a total (shards into batch totals, samples into pass/fail counts),
the sturdiest shape stores each entry under its own id and moves the total only when the entry is new:
\`HSETNX batch:outputs:{id} {shard} {payload}\` and, if it returned 1, \`HINCRBY batch:totals:{id} ...\`,
both inside one script. A replayed shard finds its entry and leaves the totals alone, and the totals
can always be recomputed from the entries if someone doubts them. Returning the new totals from the
script avoids a second read that another member could interleave with.
:::

:::details Replays on purpose
Rewinding a group (\`kafka-consumer-groups --reset-offsets --to-earliest\`, or a new \`group.id\`) is how
a team rebuilds a projection after a bug. That is only safe if one of two things holds: the effect is
idempotent by event id and the dedupe state still covers the replayed range, or the rebuild writes into
fresh state (a new key prefix or table) that is swapped in when it catches up. Replaying into live
counters whose dedupe set has expired double-counts everything older than the TTL.
:::

## 3. Handle poison records deliberately

\`\`\`python
try:
    event = parse(msg.value())
except ValueError as err:
    dlq.produce("usage.dlq", key=msg.key(), value=msg.value(),
                headers={"reason": str(err)})
    dlq.flush(5)                                       # acknowledged before the commit
    consumer.commit(message=msg, asynchronous=False)
    continue
apply_once(event)
consumer.commit(message=msg, asynchronous=False)
\`\`\`

Validate before the effect, so a half-valid record never moves a counter. Keep the original key and
bytes in the dead-letter record so it can be replayed once fixed, and alert on its rate: a sudden
stream of dead letters is an upstream bug, not noise.

:::quiz
Q: Two members of group \`eval\` hold the same redelivered sample for a moment during a rebalance. Both run \`if not redis.sismember(seen, id): redis.hincrby(totals, "passed", 1); redis.sadd(seen, id)\`. What is the outcome?
- [ ] One count: the set check prevents the second
- [x] Possibly two counts: both can pass the check before either adds the id
- [ ] Zero counts: the rebalance revokes both
> Three round trips are three moments another process can interleave with. The check and the mark have to be one atomic step with the effect: a Lua script whose \`SADD\` decides, a \`SET NX\`, or a unique constraint inside the transaction.
:::

:::details Why not just "exactly-once" in the client?
Several clients advertise exactly-once settings. Read what they cover: the idempotent producer stops
the *producer* from writing a retried record twice, and transactions bind Kafka output to Kafka input
offsets. Neither extends to a side effect outside Kafka. For those, exactly-once is something you build:
at-least-once delivery plus an effect that is idempotent by event id, applied atomically with its
dedupe mark.
:::

# Proving the fix

Tests for this failure mode have to inject the failure: a test that only runs the happy path passes
with the commit in either place. Assert on outcomes (the totals, the queued jobs, the committed
offset, the dead-letter topic), never on which functions were called.

1. **Crash after the effect, before the commit.** Feed a record, let the effect run, kill the
   consumer before it commits (raise from a commit stub, or stop the loop there). Start a fresh
   consumer on the same group. The record is delivered again; assert the total moved **exactly once**
   and the committed offset is now past the record.
2. **Crash before the effect.** Kill the consumer after the poll and before the effect. Restart.
   Assert the effect happened once: nothing was lost. A commit-first consumer fails this one.
3. **A redelivered record.** Deliver the same event twice, once at the same offset (rebalance) and
   once at a different offset with the same event id (producer retry). Assert one count.
4. **Two members at once.** Run the apply step for the same event from two threads or two
   connections. Assert one count. This is the test that separates an atomic script from a
   check-then-write.
5. **A replay.** Reset the group to the start and consume the whole topic again. Assert the totals
   are unchanged.
6. **A poison record between good ones.** Put a malformed record at offset 5 of 10. Assert the other
   nine are applied, the dead-letter topic holds the original bytes with a reason, nothing about the bad
   record reached the totals, and the committed offset reaches 10.
7. **A transient effect failure.** Make the store fail for one record. Assert it is not dead-lettered
   and not committed, and that it is applied once the store recovers.

:::details A minimal harness for the crash tests
A fake consumer that serves records from a list and records commits is enough: \`poll()\` returns the
record at the committed position, \`commit()\` advances it, and a flag makes \`commit()\` raise once.
The crash test is then: run the loop until the raise, construct a new loop over the same fake (same
committed position, same Redis), run it to the end, and compare the totals with the sum over distinct
event ids. The comparison is the proof; no mock assertions about call order are needed.
:::

# What to take away

- Kafka gives you at-least-once delivery; the committed offset is its only memory of your progress.
- Commit after the effect has returned, explicitly. Know what your client's auto-commit actually
  commits before trusting it.
- Duplicates come from crashes, rebalances, producer retries and replays, some concurrently and some
  at a different offset. Dedupe by the event id.
- Record the event id in the same atomic step as the effect: one Lua script, one transaction with a
  unique constraint, or an effect that is idempotent by nature.
- A record that will always fail goes to a dead-letter topic with its bytes and a reason; a store that
  is briefly down is retried, not dead-lettered.
- Prove it by crashing between the effect and the commit, redelivering, replaying and racing two
  members, and checking the totals.
`;

export const sources: Source[] = [
  {
    title: 'KafkaConsumer (Kafka 3.7 API)',
    url: 'https://kafka.apache.org/37/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html',
    kind: 'docs',
    venue: 'Apache Kafka',
    takes:
      'Offsets and consumer position, automatic commits via enable.auto.commit and auto.commit.interval.ms, manual offset control with commitSync after processing, and why that gives at-least-once delivery with possible duplicates.',
  },
  {
    title: 'Kafka Consumer for Confluent Platform',
    url: 'https://docs.confluent.io/platform/current/clients/consumer.html',
    kind: 'docs',
    venue: 'Confluent Documentation',
    takes:
      'Consumer groups, partition assignment and rebalancing: one owner per partition, idle members past the partition count, and members removed when their heartbeats stop.',
  },
  {
    title: "Exactly-Once Semantics Are Possible: Here's How Kafka Does It",
    url: 'https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/',
    kind: 'post',
    venue: 'Confluent blog',
    by: 'Neha Narkhede',
    date: '2017-06-30',
    takes:
      'At-most-once, at-least-once and exactly-once defined by where failures land, where duplicates come from, and that transactions cover Kafka-to-Kafka processing rather than external side effects.',
  },
  {
    title: 'Kafka Connect Deep Dive: Error Handling and Dead Letter Queues',
    url: 'https://www.confluent.io/blog/kafka-connect-deep-dive-error-handling-dead-letter-queues/',
    kind: 'post',
    venue: 'Confluent blog',
    by: 'Robin Moffatt',
    date: '2019-03-13',
    takes:
      'The three answers to a record that cannot be processed: fail fast, silently ignore, or route it to a dead-letter topic with the reason and keep the pipeline running.',
  },
  {
    title: 'KafkaJS: Consuming Messages',
    url: 'https://kafka.js.org/docs/consuming',
    kind: 'docs',
    venue: 'KafkaJS',
    takes:
      'eachMessage and eachBatch, autoCommit and its interval and threshold, manual commits with commitOffsets, and storing offsets atomically with the results in your own datastore.',
  },
];
