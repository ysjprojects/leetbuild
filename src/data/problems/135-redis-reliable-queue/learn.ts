/**
 * The learning guide for the reliable-queue drill: the visibility-timeout mechanism — where it comes
 * from, the invariant it keeps, the race it closes, and what happens to the duplicates it allows.
 * Rendered at `/redis-reliable-queue/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A **visibility timeout** is how a queue survives a worker that dies with a job in its hands. A claimed
job does not leave the queue; it becomes *invisible* for a bounded time. The worker **acks** when the
work is done and the job is deleted. If the ack never comes, the deadline passes and the job becomes
visible again for the next worker. SQS, Celery with late acks, Sidekiq Pro and Redis Streams'
consumer groups all converge on this shape; the drill builds it from four Redis keys and three Lua
scripts.

:::diagram
{
  "nodes": [
    {"id": "producer", "kind": "client", "label": "producer", "sub": "enqueue(name, job_id, payload)", "x": 10, "y": 30},
    {"id": "worker", "kind": "service", "label": "workers", "sub": "claim · ack · requeue_expired", "x": 10, "y": 70},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "q:{name}:jobs · ready · inflight · owner", "x": 60, "y": 50}
  ],
  "edges": [
    {"from": "producer", "to": "redis", "kind": "redis", "label": "HSETNX jobs · RPUSH ready"},
    {"from": "worker", "to": "redis", "kind": "redis", "label": "EVALSHA claim / ack / requeue"}
  ]
}
:::

The contract, per queue \`q:{name}\`:

| Function | What it does | Answer |
| --- | --- | --- |
| \`enqueue(name, job_id, payload)\` | \`HSETNX\` the payload into \`q:{name}:jobs\`, then \`RPUSH\` the id on \`q:{name}:ready\` | \`True\`; \`False\` for an id that already exists, nothing written |
| \`claim(name, worker, visibility_s, now)\` | one script: \`LPOP\` ready, \`ZADD\` inflight at \`now + visibility_s\`, \`HSET\` owner | \`(job_id, payload)\`; \`None\` when ready is empty |
| \`ack(name, job_id, worker)\` | one script: if the recorded owner is \`worker\`, \`ZREM\` inflight, \`HDEL\` jobs, \`HDEL\` owner | \`True\`; \`False\` for another worker, an unknown id or a second ack |
| \`requeue_expired(name, now)\` | one script: every inflight member with score \`<= now\` back to the **head** of ready, out of inflight, owner cleared | how many were requeued |
| \`stats(name)\` | \`LLEN\` ready, \`ZCARD\` inflight | \`{ready, inflight}\` |

The one-line invariant all five keep: **a job is never nowhere** — at every instant it is in exactly
one of \`ready\` or \`inflight\`.

# Why a list is not a queue

\`RPUSH\` on one side, \`LPOP\` on the other, is the first queue everyone builds on Redis. It is fine until
the moment it is not:

:::sequence
{
  "participants": ["worker A", "Redis", "worker B"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "LPOP q:emails:ready", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "j1 — and Redis forgets it", "kind": "reply"},
    {"from": "worker A", "to": "worker A", "label": "starts sending j1 … process killed by a deploy", "kind": "sync"},
    {"from": "worker B", "to": "Redis", "label": "LPOP q:emails:ready", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "j2 — j1 is gone for good", "kind": "reply"}
  ]
}
:::

\`LPOP\` is a hand-over with no receipt. The instant Redis answers, the only copy of \`j1\` is in a
process that may be killed by a deploy, an OOM, a network partition. Nothing records that the job
was taken, so nothing can give it back.

Redis's own answer was the
[reliable-queue pattern](https://redis.io/docs/latest/commands/lmove/): \`LMOVE ready processing\`
moves the element to a second list in one command, and the worker \`LREM\`s it when done. That closes
the hand-over gap but leaves the next question open: *which* entries in \`processing\` belong to a dead
worker? SQS's
[visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
answers it: every claim carries a **deadline**, and "dead" means "past its deadline". That is what
turns the processing list into a sorted set.

:::quiz
Q: A worker pops a job with \`LPOP\` and is killed before finishing it. What does the rest of the fleet see?
- [ ] The job, back on the list after the connection drops
- [x] Nothing — the list has no record that the job ever existed
- [ ] The job, delivered a second time to the next worker
> A list element that has been popped is gone. The connection closing tells Redis nothing about the work in progress; the only copy of the job died with the process. Reliability has to start with a second place the job can be while it is being worked.
:::

# Four keys, one invariant

The drill separates **what** a job is from **where** it is:

| Key | Type | Holds | Written by |
| --- | --- | --- | --- |
| \`q:{name}:jobs\` | hash | \`job_id → payload\` for every job not yet acked | \`enqueue\` (\`HSETNX\`), \`ack\` (\`HDEL\`) |
| \`q:{name}:ready\` | list | ids waiting; head is next | \`enqueue\` (\`RPUSH\` tail), \`claim\` (\`LPOP\` head), \`requeue_expired\` (\`LPUSH\` head) |
| \`q:{name}:inflight\` | sorted set | ids being worked, score = deadline | \`claim\` (\`ZADD\`), \`ack\` and \`requeue_expired\` (\`ZREM\`) |
| \`q:{name}:owner\` | hash | \`job_id → worker\` for inflight ids | \`claim\` (\`HSET\`), \`ack\` and \`requeue_expired\` (\`HDEL\`) |

The payload lives in the hash and only the **id** moves between the list and the sorted set. The
transitions, as a state machine:

\`\`\`text
enqueue         : (absent)  → ready       HSETNX jobs · RPUSH ready          refused if the id exists
claim           : ready     → inflight    LPOP · ZADD now+visibility_s · HSET owner
ack (owner)     : inflight  → (deleted)   ZREM · HDEL jobs · HDEL owner
requeue_expired : inflight  → ready       for score <= now: ZREM · HDEL owner · LPUSH ready
\`\`\`

- **Ready is a list, not a set** — order is enqueue order, and a requeued job goes to the *head* so it
  is retried before newer work rather than behind it.
- **Inflight is a sorted set scored by deadline** — the sweeper's question, "everything past \`now\`",
  is one \`ZRANGEBYSCORE inflight -inf now\`. A list would need a scan and a parse per entry.
- **The deadline is absolute** — \`now + visibility_s\` is computed at claim time and stored; the
  sweeper compares against its own \`now\`. A relative TTL would be lost the moment the worker was.
- **Ids are unique** — \`HSETNX\` refuses an id that exists, so a producer that retries an \`enqueue\`
  after a timeout does not create a second copy on \`ready\`. The producer side is idempotent by key.

\`stats\` is \`LLEN\` plus \`ZCARD\`, and the invariant says the two together count every job in \`jobs\`.

:::quiz
Q: Why is \`inflight\` a sorted set scored by deadline rather than a second list?
- [ ] Sorted sets are faster to add to than lists
- [x] So "which claims have expired" is one range query by score instead of a scan of every member
- [ ] So two workers cannot hold the same job
> The sweeper runs on a timer and must find exactly the members whose deadline has passed. With the deadline as the score, that is \`ZRANGEBYSCORE -inf now\`; with a list it is read everything, parse everything, compare everything.
:::

# Claim is one script

A claim touches three keys — pop the id, park it with its deadline, record who has it. Done from the
client, that is three round trips, and between any two of them the process can die:

:::sequence
{
  "participants": ["worker A", "Redis", "worker B"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "LPOP q:emails:ready", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "j1 — in neither ready nor inflight", "kind": "reply"},
    {"from": "worker A", "to": "worker A", "label": "crash before ZADD", "kind": "sync"},
    {"from": "worker B", "to": "Redis", "label": "EVALSHA requeue_expired · now", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "0 — nothing inflight to find", "kind": "reply"}
  ]
}
:::

The window is microseconds wide and it is enough: \`j1\` is in no key, the sweeper has nothing to
sweep, and nobody can tell from the data. So the whole transition is one Lua script, which Redis runs
[atomically](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/) — no other
command interleaves, and the three writes land together or not at all:

\`\`\`lua
-- KEYS: ready, inflight, owner, jobs   ARGV: worker, deadline (now + visibility_s)
local id = redis.call('LPOP', KEYS[1])
if not id then
  return nil
end
redis.call('ZADD', KEYS[2], ARGV[2], id)
redis.call('HSET', KEYS[3], id, ARGV[1])
return {id, redis.call('HGET', KEYS[4], id)}
\`\`\`

- **Keys in a fixed order, values in ARGV.** The client function builds the four key names and
  passes the worker and the deadline; it sends nothing but \`EVALSHA\`. Declaring every key up front is
  also what lets a Redis Cluster route the script.
- **Empty list answers nil.** \`LPOP\` on an empty list gives Lua \`false\`; the script returns \`nil\` and
  the client answers \`None\`, not an exception.
- **The payload rides back with the id** as a two-element table, so a claim is one round trip and the
  worker never needs a second \`HGET\` that could see a job already acked by someone else.
- **Register once, call by hash.** \`register_script\` / \`defineCommand\` / \`NewScript\` load the body
  once; every call afterwards is \`EVALSHA\` with the keys and arguments.

Two workers claiming at the same instant cannot pop the same id: Redis runs one script, then the
other, and the second \`LPOP\` sees a list the first already shortened.

:::details Why not MULTI / EXEC
A \`MULTI\` block is atomic too, but it cannot branch: the \`ZADD\` needs the id \`LPOP\` returns, and
inside a transaction no command sees another's reply. \`WATCH\` plus a retry loop can fake it, at a
round trip per attempt and a retry storm under contention. A script reads, decides and writes
server-side in one go.
:::

:::quiz
Q: A worker crashes between a client-side \`LPOP\` and the \`ZADD\` that was to follow. Who finds the job?
- [ ] The sweeper, on its next pass, because the job has no deadline
- [ ] The next worker to claim, because the pop was never committed
- [x] Nobody: the job is in neither \`ready\` nor \`inflight\`, and no key records that it was taken
> The sweeper only sees \`inflight\`; the next claimer only sees \`ready\`. A job that is in neither is invisible to both, which is why the pop and the park must be one atomic step.
:::

# Ownership on ack

The deadline creates a new failure: a worker that is *slow*, not dead. It passes its deadline, the
sweeper hands the job to someone else, and then the first worker finishes and acks. Without a
guard, that ack deletes a job the second worker is halfway through:

:::sequence
{
  "participants": ["worker A", "worker B", "Redis"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "EVALSHA claim · ready inflight owner jobs · A · now+30", "kind": "sync"},
    {"from": "Redis", "to": "Redis", "label": "LPOP → j1 · ZADD inflight 130 j1 · HSET owner j1 A", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "[j1, payload]", "kind": "reply"},
    {"from": "worker B", "to": "Redis", "label": "EVALSHA requeue_expired · now = 131", "kind": "sync"},
    {"from": "Redis", "to": "Redis", "label": "ZRANGEBYSCORE -inf 131 → j1 · ZREM · HDEL owner · LPUSH ready", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "1", "kind": "reply"},
    {"from": "worker B", "to": "Redis", "label": "EVALSHA claim · B · now+30", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "[j1, payload]", "kind": "reply"},
    {"from": "worker A", "to": "Redis", "label": "EVALSHA ack · j1 · A (late)", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "0 — owner is B now", "kind": "reply"}
  ]
}
:::

The \`owner\` hash is the guard. \`ack\` compares before it deletes, inside the same script:

\`\`\`lua
-- KEYS: inflight, owner, jobs   ARGV: job_id, worker
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
  return 0
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
\`\`\`

| Ack from | Owner recorded | Answer | Effect |
| --- | --- | --- | --- |
| A, before its deadline | A | \`True\` | id gone from \`inflight\`, \`jobs\`, \`owner\` |
| A, after the sweeper and B's claim | B | \`False\` | nothing; B's work is safe |
| A, a second time | none (\`false\` in Lua) | \`False\` | nothing |
| anyone, unknown id | none | \`False\` | nothing |

This is the queue's form of a
[fencing token](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html): the
right to delete the job belongs to whoever holds the *current* claim, and a stale claimant's request
is refused rather than trusted. SQS does the same with the receipt handle — a \`DeleteMessage\` with
the handle from an expired receive fails. The compare and the deletes are one script for the same
reason as \`claim\`: a client-side \`HGET\`, then \`ZREM\`, leaves a window in which the sweeper can
reassign the job between the check and the delete.

Note what the late worker *did* do: it finished the job, so its side effect happened, and B is about
to repeat it. The refused ack protects the **queue's** state; the duplicate work is the next section.

:::quiz
Q: Worker A's claim expired and worker B now holds the job. A finishes and calls \`ack\`. What should happen?
- [ ] Delete the job — A did the work, so it is done
- [x] Refuse with \`False\`; the recorded owner is B, and B's claim stands
- [ ] Delete the job and cancel B's claim
> A's claim is stale. If its ack were honoured, B's eventual ack would find nothing and B's result would be the second copy of work the queue thinks never completed. The owner check makes the current claimant the only one who can close the job.
:::

# The sweeper, and the duplicates it creates

\`requeue_expired\` is deliberately dumb. By construction, every \`inflight\` member past its deadline is a
job whose worker went quiet; the sweep does not ask why:

\`\`\`lua
-- KEYS: inflight, owner, ready   ARGV: now
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('HDEL', KEYS[2], id)
  redis.call('LPUSH', KEYS[3], id)
end
return #expired
\`\`\`

- **Expired means** \`score <= now\` — a deadline of \`130\` is expired at \`now = 130\`; at \`129\` the job stays with
  its owner and the sweep returns \`0\`.
- **Head of the list** — \`LPUSH\`, so the retry runs before work that arrived later. Three jobs
  inflight at deadlines \`100\`, \`120\`, \`200\` and a sweep at \`130\` requeues two, returns \`2\`, and leaves
  the third with its owner.
- **One script** — the range read and every write happen together, so a worker claiming mid-sweep
  sees either the old state or the new, never an id in both keys.
- **Called on a timer** — the drill leaves the loop to the caller; a real deployment runs it every
  second or so from any worker, and running it twice is harmless.

What the sweep guarantees is **at-least-once**: a job is retried until an ack lands. What it cannot
guarantee is *once*. Every requeue after a worker that was slow rather than dead is a duplicate
delivery, and the queue has no way to tell the two apart — a slow worker and a dead one look
identical from Redis.

:::widget delivery-semantics {}

Choosing \`visibility_s\` is choosing between the two failure modes:

| \`visibility_s\` | Dead worker | Slow worker |
| --- | --- | --- |
| short | job retried quickly | duplicated often |
| long | job stuck for a long time | duplicated rarely |

SQS defaults to 30 seconds and lets a worker extend its own deadline with \`ChangeMessageVisibility\`;
that heartbeat is one of the things the drill leaves out. The other half of the answer is on the
consumer: since a job can arrive twice, the **work must be idempotent** — key the side effect on
\`job_id\` (an \`INSERT … ON CONFLICT DO NOTHING\`, a payment with an idempotency key, a
\`SETNX done:{job_id}\`) so the second execution is a no-op. A queue that promises at-least-once and
a consumer that assumes exactly-once is the bug; both halves have to agree.

Real systems add what the drill omits: a **retry counter** and a **dead-letter list**, so a job that
expires too many times is parked for a human instead of cycling forever; a **heartbeat** that extends
the deadline for long jobs; **blocking** claims (\`BLPOP\`-style) instead of polling an empty list; and
a metric on the age of the oldest inflight member. Redis Streams with consumer groups —
[\`XREADGROUP\`](https://redis.io/docs/latest/commands/xreadgroup/) to claim, \`XACK\` to ack,
\`XAUTOCLAIM\` to sweep idle entries — are this exact protocol built into the server, with the
pending-entries list playing the part of \`inflight\` and \`owner\` together.

:::quiz
Q: Worker A takes 45 s on a job with \`visibility_s = 30\` and succeeds. What has the queue done?
- [ ] Nothing unusual: A's ack deletes the job
- [x] Requeued the job at 30 s; another worker runs it a second time, and A's ack is refused
- [ ] Extended A's deadline because A was still connected
> The sweeper cannot distinguish slow from dead; past the deadline the job goes back and is claimed again. The side effect of A's run already happened, so the consumer must be idempotent — or A must heartbeat to extend the deadline, which this queue does not provide.
:::

# What to take away

- **A popped element is a lost element.** Reliability starts with a second place a job can be while
  it is being worked, and a deadline that says when "being worked" has gone on too long.
- **A job is never nowhere.** Four keys, and every transition between them is one Lua script, so
  \`ready\` and \`inflight\` partition the jobs at every instant — a crash in the middle has no middle.
- **The deadline is the score.** An absolute \`now + visibility_s\` in a sorted set makes the sweep a
  single \`ZRANGEBYSCORE -inf now\` and lets the sweeper be stateless.
- **Ownership fences the ack.** The current claimant is the only one who can close a job; a stale
  worker's late ack is refused rather than trusted.
- **At-least-once means duplicates.** The sweeper retries what it cannot tell apart from dead; the
  consumer must make the second run a no-op.

The primary reference is Amazon's
[*Amazon SQS visibility timeout*](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
page: the same mechanism as a managed service, including the receipt-handle check on delete and the
heartbeat this drill leaves to the caller.
`;
