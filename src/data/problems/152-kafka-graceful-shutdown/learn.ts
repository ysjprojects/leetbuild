/**
 * The learning guide for the graceful-shutdown drill: what a Kafka worker's stop must preserve, why
 * drain → flush → commit → close is the only order, how one deadline bounds every wait, and what a
 * restart does with the report. Rendered at `/kafka-graceful-shutdown/learn`; the download exports
 * the same Markdown.
 */
export const learn = `# The mechanism at a glance

Every Kafka worker is killed routinely — a deploy rolls it, an autoscaler drains it, a node goes
away. Between the SIGTERM and the SIGKILL there is a budget (thirty seconds on Kubernetes by
default), and what the worker does with it decides whether the stop is invisible or a page. The
worker here is a **forwarder**, the loop inside every stream processor, CDC connector and outbox
relay: consume, transform, produce, commit.

:::diagram
{
  "nodes": [
    {"id": "upstream", "kind": "client", "label": "upstream", "sub": "produces inbox", "x": 10, "y": 50},
    {"id": "forwarder", "kind": "service", "label": "forwarder", "sub": "run(handler) · shutdown(deadline_s)", "x": 50, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "Kafka", "sub": "inbox → outbox · group forwarder", "x": 88, "y": 50}
  ],
  "edges": [
    {"from": "upstream", "to": "kafka", "kind": "kafka", "label": "inbox"},
    {"from": "kafka", "to": "forwarder", "kind": "kafka", "label": "poll inbox · commit offset + 1 after the ack"},
    {"from": "forwarder", "to": "kafka", "kind": "kafka", "label": "produce outbox (same key)"}
  ]
}
:::

The contract has two entry points:

- \`run(handler)\` consumes \`inbox\` in the consumer group \`forwarder\` with auto-commit **off** and
  \`auto.offset.reset=earliest\`. For every record it calls \`handler(record)\`, produces the result to
  \`outbox\` under the **same key**, and commits \`offset + 1\` only **after the broker acknowledged the
  forward** — never before, and never past a record whose forward is still in flight.
- \`shutdown(deadline_s)\` stops taking records, lets the one in hand finish, flushes the producer
  with the time left, commits synchronously every offset that is safe, closes both clients, and
  returns \`{"forwarded", "committed_offsets", "undelivered", "uncommitted"}\` — all within
  \`deadline_s\` of clock time, whatever the broker does.
- A restart (\`run\` in a fresh process) resumes from the committed offsets. A record forwarded but
  not committed is handled again; a record committed never is.

> A stop is a deadline, not an event: everything the worker still owes the broker — the forward in
> flight, the commit behind it, the sockets — gets the time that is left, and what does not fit is
> reported, not lost.

# What a stop must preserve

Two things can go wrong when a consume-and-forward worker dies, and they pull in opposite
directions:

| Failure | How it happens | Who notices |
| --- | --- | --- |
| **Loss** | an offset is committed before its forward reached \`outbox\`; the restart skips the record | nobody, until a downstream count is short |
| **Unbounded duplicates** | nothing is committed for a long time; the restart replays everything since the last commit | the downstream, as a storm |
| **A hang** | the worker waits on a dead broker without a bound; SIGKILL arrives mid-commit | the deploy, as a stuck rollout |

The naive worker commits whatever it has polled and exits when told:

:::sequence
{
  "participants": ["supervisor", "naive worker", "Kafka"],
  "messages": [
    {"from": "Kafka", "to": "naive worker", "label": "poll → inbox[0]@7", "kind": "reply"},
    {"from": "naive worker", "to": "Kafka", "label": "commit inbox[0] → 8 (auto-commit, before the forward)", "kind": "sync"},
    {"from": "naive worker", "to": "naive worker", "label": "handler(record)", "kind": "sync"},
    {"from": "naive worker", "to": "Kafka", "label": "produce outbox key=k7 — sits in the producer buffer", "kind": "async"},
    {"from": "supervisor", "to": "naive worker", "label": "SIGTERM", "kind": "sync"},
    {"from": "naive worker", "to": "supervisor", "label": "exit — buffer discarded, offset 8 committed", "kind": "reply"},
    {"from": "Kafka", "to": "naive worker", "label": "restart: poll → inbox[0]@8 — record 7 never reaches outbox", "kind": "reply"}
  ]
}
:::

The rule that prevents it is the one \`run\` lives by: **commit after the ack, never before**. The
offset is a promise that everything below it reached \`outbox\`; it can only be made once the broker
has said so. The other half of the contract is that duplicates are *bounded and reported*: a
restart may redeliver exactly the records the report counted as \`uncommitted\`, and no more.

:::widget delivery-semantics {}

This is Kafka's
[at-least-once](https://kafka.apache.org/documentation/#semantics) position: processing first,
commit second, so a crash between the two replays rather than skips. The shutdown is where the
"crash between the two" stops being an accident and becomes a window the worker controls.

:::quiz
Q: A forward to \`outbox\` has been produced but the broker has not acknowledged it. The worker is asked to stop. What may it commit for that record's partition?
- [ ] The record's offset + 1 — the produce call returned, so the forward is done
- [x] Only up to that record; its offset stays uncommitted until the ack arrives or the deadline runs out
- [ ] Nothing at all for the partition, to be safe
> A produce call hands the record to a buffer; the broker has not got it. Committing past it would skip the record on restart if the buffer never drains. Committing nothing is safe but wasteful: every acknowledged record below it can be committed, and that bounds what the restart replays.
:::

# The order is forced: drain, flush, commit, close

A graceful shutdown is the loop in reverse. Each step is placed by what it owes the one before
it:

:::sequence
{
  "participants": ["supervisor", "forwarder", "Kafka"],
  "messages": [
    {"from": "Kafka", "to": "forwarder", "label": "poll → inbox[0]@7", "kind": "reply"},
    {"from": "forwarder", "to": "forwarder", "label": "handler(record)", "kind": "sync"},
    {"from": "forwarder", "to": "Kafka", "label": "produce outbox key=k7", "kind": "async"},
    {"from": "supervisor", "to": "forwarder", "label": "shutdown(5)", "kind": "sync"},
    {"from": "forwarder", "to": "forwarder", "label": "stop polling; the record in hand finishes", "kind": "sync"},
    {"from": "Kafka", "to": "forwarder", "label": "ack outbox (flush, ≤ time left)", "kind": "async"},
    {"from": "forwarder", "to": "Kafka", "label": "commit inbox[0] → 8 (sync)", "kind": "sync"},
    {"from": "forwarder", "to": "Kafka", "label": "close consumer · close producer", "kind": "sync"},
    {"from": "forwarder", "to": "supervisor", "label": "{forwarded, committed_offsets, undelivered: 0, uncommitted: 0}", "kind": "reply"}
  ]
}
:::

| Step | What it does | Why it is here and not later |
| --- | --- | --- |
| 1. **Stop taking records** | the poll loop ends | anything polled now is a promise to forward with no time to keep it |
| 2. **Let the record in hand finish** | the running \`handler\` completes, its forward is produced | its offset is the next commit; abandoning it mid-handler just adds a duplicate |
| 3. **Flush with the time left** | \`producer.flush(remaining)\` waits for the broker's acks | a commit before the ack would acknowledge a record \`outbox\` never got |
| 4. **Commit synchronously** | the safe offset per partition, confirmed by the broker | an async commit queued behind a closing socket is a commit that never happened |
| 5. **Close both clients** | consumer first, then producer | the consumer leaves the group cleanly; a restart starts from what the broker holds |
| 6. **Report** | \`forwarded\`, \`committed_offsets\`, \`undelivered\`, \`uncommitted\` | the restart's redelivery is expected rather than a surprise |

Two of these are the ones every first implementation gets wrong. **Flush before commit** — the
loop's commits lag the acks, so the final commit sits behind the flush, not beside it.
**Synchronous at the end** — the last commit has nothing behind it to cover for it, so it waits for
the broker's answer and only then lets
[\`close\`](https://kafka.apache.org/40/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html#close(java.time.Duration))
run.

:::details Why the consumer's own close is not enough
A consumer's \`close\` leaves the group; it knows nothing about the producer's buffer. Closing it
while forwards are still in the producer is the naive sequence above with a politer name. The
producer has \`flush\` for its half; only the worker knows the two halves belong together, so the
worker orders them.
:::

:::quiz
Q: Why must the final commit be synchronous when the loop's commits were asynchronous?
- [ ] Asynchronous commits are unsafe; the loop should have used synchronous ones too
- [x] A loop commit is covered by the next one; the last commit has no next one, so it must be confirmed before the consumer goes away
- [ ] Synchronous commits are faster at shutdown because the broker is idle
> Async commits trade a possibly lost commit for throughput, which is fine while there is a later commit to cover it. At shutdown the queue behind the commit is a closing socket. Waiting for the broker's answer is the only way to know the offset made it.
:::

# Every wait gets the time left

The deadline is a **budget for the whole call**, not a timeout per step. Note the clock when
\`shutdown\` starts and hand each wait what remains:

\`\`\`python
started = time.monotonic()
remaining = lambda: max(0.0, deadline_s - (time.monotonic() - started))

stopping = True                             # the record in hand finishes, bounded by remaining()
left = producer.flush(remaining())          # forwards still unacknowledged after the wait
consumer.commit(offsets=safe, asynchronous=False)
consumer.close()
\`\`\`

Three rules fall out of the budget:

- **The clock decides, not the broker.** A dead broker costs the deadline, not
  \`message.timeout.ms\`; \`flush(remaining)\` returns at the deadline with the count of forwards still
  in the buffer.
- **No waiting out the deadline.** When every forward is acknowledged early, \`flush\` returns early
  and \`shutdown\` returns well inside \`deadline_s\`. The deadline is a cap, not a sleep.
- **What does not fit is not retried into the deadline.** A forward that did not make it stays
  uncommitted and is counted; the restart is the retry.

With the broker stalled, the same stop looks like this:

:::sequence
{
  "participants": ["supervisor", "forwarder", "Kafka"],
  "messages": [
    {"from": "Kafka", "to": "forwarder", "label": "poll → inbox[0]@7, @8, @9 — 7 acked, 8 and 9 in flight", "kind": "reply"},
    {"from": "supervisor", "to": "forwarder", "label": "shutdown(5) · t = 0", "kind": "sync"},
    {"from": "forwarder", "to": "Kafka", "label": "flush(5.0) — outbox not acknowledging", "kind": "async"},
    {"from": "forwarder", "to": "forwarder", "label": "t = 5: flush returns 2 undelivered", "kind": "sync"},
    {"from": "forwarder", "to": "Kafka", "label": "commit inbox[0] → 8 (sync) — not 10", "kind": "sync"},
    {"from": "forwarder", "to": "Kafka", "label": "close consumer · close producer", "kind": "sync"},
    {"from": "forwarder", "to": "supervisor", "label": "{forwarded: 1, committed_offsets: {0: 8}, undelivered: 2, uncommitted: 2} · t ≈ 5", "kind": "reply"}
  ]
}
:::

The worker was back within five seconds, committed only what was acknowledged, and told the
supervisor that two records will be seen again. A supervisor that gets the process back in five
seconds moves on; one that gets nothing for thirty-one sends SIGKILL and learns nothing.

:::widget deadline-retry {}

:::quiz
Q: \`shutdown(5)\` is called while \`handler\` is two seconds into a record. The broker then takes four seconds to acknowledge the forward. What happens?
- [ ] The handler gets 5 s and the flush gets 5 s, so the call returns at about 6 s
- [x] The flush gets what is left after the handler — about 3 s — so it returns at the deadline with the forward undelivered and the record uncommitted
- [ ] The call waits for the ack because losing a forward is worse than missing the deadline
> One budget covers the whole call. The handler spends two seconds of it, the flush gets the remaining three and the ack arrives a second too late. The record is reported, stays uncommitted, and the restart forwards it again — that is the at-least-once path, and it is cheaper than being killed mid-commit.
:::

# The safe offset, the report, and the restart

Commit-after-ack with forwards in flight needs one piece of bookkeeping: per \`inbox\` partition,
the records taken and not yet committed, in offset order, each flagged when its delivery callback
fires. The offset that may be committed is **one past the leading run of acknowledged records** —
the first unacknowledged one blocks everything behind it, even if later forwards were acked:

| Pending on partition 0 | Acked? | Safe to commit |
| --- | --- | --- |
| @7 | yes | → 8 |
| @8 | no — still in the buffer | blocks here: the watermark is 8 |
| @9 | yes | not yet; 9 was acked but 8 was not |

Committing \`10\` here would be the loss from the first section: a restart skips @8 forever.
Committing \`8\` makes @8 and @9 the restart's job — two duplicates, both counted.

The report is the handover to whoever restarts the worker:

\`\`\`json
{"forwarded": 1, "committed_offsets": {"0": 8}, "undelivered": 2, "uncommitted": 2}
\`\`\`

- \`forwarded\` — forwards the broker acknowledged since \`run\` started.
- \`committed_offsets\` — the committed offset per \`inbox\` partition, confirmed by the broker.
- \`undelivered\` — forwards still unacknowledged when the flush gave up.
- \`uncommitted\` — records taken from \`inbox\` whose offset is not committed; the number the restart
  will see again. It can exceed \`undelivered\`: @9 was delivered but is uncommitted because @8 was not.

The restart is the recovery path, and it is cheap because the group remembers:

:::sequence
{
  "participants": ["fresh process", "Kafka", "outbox"],
  "messages": [
    {"from": "fresh process", "to": "Kafka", "label": "subscribe inbox · group forwarder · auto.offset.reset=earliest", "kind": "sync"},
    {"from": "Kafka", "to": "fresh process", "label": "committed offset for inbox[0] is 8 → poll → @8", "kind": "reply"},
    {"from": "fresh process", "to": "outbox", "label": "produce key=k8 (again, if the stalled forward had landed late)", "kind": "async"},
    {"from": "fresh process", "to": "Kafka", "label": "commit inbox[0] → 9 after the ack", "kind": "sync"},
    {"from": "Kafka", "to": "fresh process", "label": "poll → @9 — forwarded once more, then @10, new ground", "kind": "reply"}
  ]
}
:::

\`auto.offset.reset=earliest\` matters only for a group with **no** committed offset — the very
first start, or a group whose offsets expired. With \`latest\`, a brand-new worker would skip
everything already in \`inbox\`. After any committed offset exists, the consumer's
[position](https://kafka.apache.org/documentation/#design_consumerposition) comes from the group,
not from the setting.

Across a clean stop — \`undelivered: 0\`, \`uncommitted: 0\` — the restart handles only the records
that arrived since: each record reaches the handler once and \`outbox\` once, without any
transaction. Duplicates appear only when the report said they would.

:::quiz
Q: The report says \`undelivered: 1, uncommitted: 2\`. How can more records be uncommitted than forwards are undelivered?
- [ ] The report is inconsistent; uncommitted can never exceed undelivered
- [x] A later record's forward was acknowledged, but an earlier one on the same partition was not, so the safe offset stopped below both
- [ ] The consumer was closed before the commit, so the offsets were lost
> The two counters measure different things. \`undelivered\` is what the producer still held when the flush returned; \`uncommitted\` is what the group has not been told about. The commit is a single offset per partition, so one unacknowledged forward holds back every acknowledged record behind it. Both are forwarded again on restart — duplicates, counted, not lost.
:::

# SIGTERM and rebalances in production

The drill calls \`shutdown\` directly; production has two callers, and they want the same stop.

| Trigger | Who calls | Budget | What differs |
| --- | --- | --- | --- |
| **SIGTERM** | the orchestrator, before SIGKILL | \`terminationGracePeriodSeconds\`, 30 s by default on Kubernetes | the whole process stops; every partition is drained |
| **Partition revoke** | the consumer client, on a rebalance | \`max.poll.interval.ms\` — the next \`poll\` must happen inside it | one partition's forwards are flushed and committed; the process keeps running |
| **Crash / SIGKILL** | nobody | none | the committed offsets are the only state; the restart replays from them |

On Kubernetes the sequence is fixed: the pod is marked terminating and removed from endpoints, the
\`preStop\` hook runs, SIGTERM is sent, and after
[the grace period](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
SIGKILL. A worker that hands SIGTERM to \`shutdown(grace - margin)\` is back before the kill with a
report in its logs; one that ignores SIGTERM gets the crash row every deploy.

A **rebalance** is the same stop for one partition. The client revokes partitions from this worker
and hands them to another, which starts from the committed offset. So the revoke callback does the
drain-flush-commit for the partitions leaving — with a deadline, because the rebalance is on a
clock too — and the group replays only what that callback could not commit. Confluent's
[multi-threaded consumer](https://www.confluent.io/blog/kafka-consumer-multi-threaded-messaging/)
write-up walks through exactly that: finishing in-flight records and committing on revoke.

Real systems add three things the drill leaves out on purpose:

- **Idempotent downstream writes**, so the at-least-once replay is harmless rather than merely
  bounded.
- **Kafka transactions**, when the forward and the commit must move together as one atomic unit.
- **Signal plumbing**: a SIGTERM handler that calls \`shutdown\` once and ignores a second signal
  while it runs.

:::quiz
Q: A rolling deploy replaces the worker's pod. Which single setting decides how much time \`shutdown\` may take?
- [ ] \`max.poll.interval.ms\` — the consumer must poll again before it
- [x] The pod's termination grace period — SIGKILL arrives when it ends, whatever the worker is doing
- [ ] \`message.timeout.ms\` — the producer gives up on the forward after it
> The grace period is the hard ceiling: once it expires the process is gone, mid-commit or not. The deadline passed to \`shutdown\` has to fit inside it with a margin; the Kafka timeouts are bounds on individual operations, and the whole point of the budget is that none of them is allowed to spend the time the stop does not have.
:::

# What to take away

- **Commit after the ack, never before.** The offset is a promise that everything below it reached
  \`outbox\`; the safe offset is one past the leading run of acknowledged records.
- **The order is forced.** Stop taking records, let the one in hand finish, flush, commit
  synchronously, close — each step owes the previous one.
- **One deadline, every wait gets the time left.** The clock decides, not the broker; return at
  the deadline, not after it, and not later than necessary when the work is done.
- **Report what did not fit.** \`undelivered\` and \`uncommitted\` turn the restart's at-least-once
  redelivery from a surprise into an expected, bounded replay.
- **A revoke is a shutdown of one partition; SIGTERM is a shutdown of all of them.** Same
  discipline, different budget.

The primary reference is the Kafka documentation's
[*Message delivery semantics*](https://kafka.apache.org/documentation/#semantics): the at-least-once
contract this stop preserves, in the project's own words, and why committing the position after
processing is the choice that loses nothing.
`;
