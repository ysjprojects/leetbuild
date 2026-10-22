/**
 * The learning guide for the delayed-jobs drill: a sorted set as a timer, the atomic pop, the backoff
 * arithmetic, the dead list, and the worker that dies with a job in hand — a figure or a demo where
 * one says it faster than prose, a pop quiz per section.
 * Rendered at `/redis-delayed-jobs/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

"Send this email in ten minutes; if it fails, try again later, but not forever." Sidekiq's scheduled
set, Celery's Redis broker and BullMQ's delayed jobs all answer that with the same Redis shape: a
**sorted set** whose member is the job id and whose score is the millisecond it becomes due. The
drill builds that queue as one module over four keys:

:::diagram
{
  "nodes": [
    {"id": "scheduler", "kind": "client", "label": "scheduler", "sub": "schedule(job_id, payload, run_at_ms)", "x": 10, "y": 50},
    {"id": "worker", "kind": "service", "label": "worker", "sub": "pop_due · fail · complete", "x": 45, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "jobs:delayed · jobs:payload · jobs:attempts · jobs:dead", "x": 80, "y": 50}
  ],
  "edges": [
    {"from": "scheduler", "to": "redis", "kind": "redis", "label": "HSET payload · ZADD delayed"},
    {"from": "worker", "to": "redis", "kind": "redis", "label": "EVAL pop · HINCRBY · ZADD / RPUSH dead"}
  ]
}
:::

| Key | Type | Holds |
| --- | --- | --- |
| \`jobs:delayed\` | sorted set | job id → \`run_at_ms\`; the index by time |
| \`jobs:payload\` | hash | job id → payload; what the worker runs |
| \`jobs:attempts\` | hash | job id → failures so far; absent means 0 |
| \`jobs:dead\` | list | ids that failed \`MAX_ATTEMPTS\` (5) times, oldest first |

The contract, in five functions:

- \`schedule(job_id, payload, run_at_ms)\` — \`HSET jobs:payload\`, then \`ZADD jobs:delayed run_at_ms job_id\`.
- \`pop_due(now_ms, limit)\` — **one Lua script** that selects up to \`limit\` ids with score \`≤ now_ms\`,
  removes each from \`jobs:delayed\`, and returns \`(job_id, payload, attempt)\` triples in \`run_at\` order.
- \`backoff_ms(attempt)\` — \`min(BASE_MS × 2^(attempt − 1), MAX_BACKOFF_MS)\`, \`BASE_MS = 1000\`,
  \`MAX_BACKOFF_MS = 60000\`.
- \`fail(job_id, now_ms)\` — count the failure; reschedule at \`now_ms + backoff_ms(attempt)\` or, on the
  fifth, park the id on \`jobs:dead\`.
- \`complete(job_id)\` — delete the payload and the attempt count; nothing of the job remains.

Time is an argument everywhere — \`run_at_ms\`, \`now_ms\` — never a clock read. The queue is a pure
function of its inputs, which is what makes "what happens at 5000, then at 6000" testable at all.

# A sorted set is a timer wheel

A queue of things to do *later* needs one query: "everything whose time has come, earliest first".
A list cannot answer it without a scan; a
[sorted set](https://redis.io/docs/latest/develop/data-types/sorted-sets/) answers it in
\`O(log N + M)\` because its members are kept ordered by score. Make the score the due time and the
set *is* the timer:

\`\`\`text
HSET jobs:payload j1 '{"to": "ana@…", "template": "welcome"}'
ZADD jobs:delayed 5000 j1            # due at t = 5000 ms
ZADD jobs:delayed 7000 j2
ZRANGEBYSCORE jobs:delayed -inf 4000 LIMIT 0 10   → []        nothing due yet
ZRANGEBYSCORE jobs:delayed -inf 5000 LIMIT 0 10   → [j1]      j2 stays, due at 7000
\`\`\`

Three design choices hide in those lines:

- **The member is the id, not the job.** The payload lives in \`jobs:payload\`, the failure count in
  \`jobs:attempts\`. A reschedule is then a **score update** — \`ZADD\` on an existing member moves it —
  not a remove-and-reinsert of a serialised blob, and the payload survives for inspection after the
  job is dead.
- **The lower bound is** \`-inf\`. A job due at 3000 that nobody popped until 9000 is still "due"; the
  query asks for everything at or before \`now\`, not a window around it.
- **A batch, not everything:** \`LIMIT 0 limit\`. A worker takes what it can finish; what it did not take stays in the set for
  the next poll, in order.

:::details ZRANGEBYSCORE and ZRANGE BYSCORE
Since Redis 6.2 \`ZRANGEBYSCORE key min max\` is spelled
[\`ZRANGE key min max BYSCORE\`](https://redis.io/docs/latest/commands/zrange/) and the old command is
marked deprecated; both still run, and the old spelling is what Sidekiq, Celery and most tutorials
use. The semantics are identical: a closed range on the score, \`-inf\`/\`+inf\` as bounds, \`LIMIT
offset count\` to page.
:::

:::quiz
Q: Why keep the payload in a hash rather than encoding it into the sorted-set member?
- [ ] Sorted-set members have a length limit that payloads would exceed
- [x] So a retry is one \`ZADD\` that moves a score, and a dead job's payload is still readable
- [ ] Hashes are faster than sorted sets to read
> With the id as member, rescheduling is a score update on the same member and the dead list can hold bare ids while the payload stays where it was. A member that is the serialised job would have to be removed and re-added on every retry and copied into the dead list.
:::

# The pop is the hard part

"What is due" is one command; "give it to *me* and nobody else" is not. The first version every
delayed queue ships reads the ids with \`ZRANGEBYSCORE\` and removes them with a second \`ZREM\` from
the client. Between those two round trips the ids are still in the set, and every other worker
polling in that window reads the same ones:

:::sequence
{
  "participants": ["worker A", "worker B", "Redis"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "ZRANGEBYSCORE jobs:delayed -inf 5000 LIMIT 0 10", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "[j1]", "kind": "reply"},
    {"from": "worker B", "to": "Redis", "label": "ZRANGEBYSCORE jobs:delayed -inf 5000 LIMIT 0 10", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "[j1] — still there", "kind": "reply"},
    {"from": "worker A", "to": "Redis", "label": "ZREM jobs:delayed j1 → 1", "kind": "sync"},
    {"from": "worker B", "to": "Redis", "label": "ZREM jobs:delayed j1 → 0, but B already has the payload", "kind": "sync"},
    {"from": "worker A", "to": "worker A", "label": "send welcome email to ana", "kind": "sync"},
    {"from": "worker B", "to": "worker B", "label": "send welcome email to ana — again", "kind": "sync"}
  ]
}
:::

Checking \`ZREM\`'s return value — "1 means I won" — would fix this if the worker read the payload
*after* winning, and that is a legitimate design (Sidekiq's scheduler does exactly that per id). The
drill takes the other route: put the read and the remove in **one Lua script**, which Redis runs
with nothing interleaved between its commands:

\`\`\`lua
-- KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
-- ARGV[1] = now_ms   ARGV[2] = limit
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local out = {}
for _, id in ipairs(due) do
  redis.call('ZREM', KEYS[1], id)
  out[#out + 1] = id
  out[#out + 1] = redis.call('HGET', KEYS[2], id) or ''
  out[#out + 1] = redis.call('HGET', KEYS[3], id) or '0'
end
return out
\`\`\`

:::sequence
{
  "participants": ["worker A", "worker B", "Redis"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "EVAL pop · KEYS delayed, payload, attempts · ARGV 5000, 10", "kind": "sync"},
    {"from": "Redis", "to": "Redis", "label": "ZRANGEBYSCORE → [j1] · ZREM j1 · HGET payload · HGET attempts", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "[j1, {…}, 0]", "kind": "reply"},
    {"from": "worker B", "to": "Redis", "label": "EVAL pop · ARGV 5000, 10 — queued behind A's script", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "[] — j1 is gone", "kind": "reply"}
  ]
}
:::

- **Atomic by construction.** Redis is single-threaded for commands, and a
  [script runs as one command](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/):
  B's \`EVAL\` cannot start until A's has returned. An id the script returned is an id nobody else
  will see.
- **Remove before reading:** \`ZREM\` inside the loop, first. The claim happens the moment the id is removed; the
  \`HGET\`s that follow are reads of a job that is already yours.
- **A flat reply.** \`id, payload, attempts, id, payload, attempts…\`, split in threes on the client. A
  nested Lua table with a \`nil\` in it loses elements, and \`HGET\` of a missing field is \`false\` in Lua
  — hence \`or '0'\`.
- **Keys declared, not hard-coded.** \`KEYS = [jobs:delayed, jobs:payload, jobs:attempts]\` lets Redis
  Cluster route the script and lets a reviewer see every key it touches.

:::quiz
Q: Two workers call \`pop_due(5000, 10)\` at the same instant and \`j1\` is the only due job. What happens?
- [x] One gets \`[(j1, …, 0)]\`, the other gets \`[]\`; which one is arbitrary
- [ ] Both get \`j1\`; the second \`ZREM\` returns 0 so the second worker should skip it
- [ ] Redis returns an error to the second caller because the key is locked
> Scripts execute one at a time. Whichever EVAL Redis runs first removes j1 inside the script; the other script's ZRANGEBYSCORE then sees an empty range. There is no lock to error on and no second ZREM to check — the claim is the script.
:::

# Backoff: double, then stop doubling

A failed job is usually failed because something downstream is unhappy — a mail provider timing out,
a third-party API rate-limiting. Retrying at once makes that worse; retrying at a fixed interval
makes every job that failed in the same second retry in the same second again. The standard answer,
set out in AWS's
[*Exponential Backoff and Jitter*](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/),
is to double the wait per attempt and cap it:

\`\`\`text
backoff_ms(attempt) = min(BASE_MS × 2^(attempt − 1), MAX_BACKOFF_MS)
                    = min(1000 × 2^(attempt − 1), 60000)
\`\`\`

| Attempt | Uncapped | \`backoff_ms\` | Rescheduled at (\`now\` = 5000) |
| --- | --- | --- | --- |
| 1 | 1000 | 1 s | 6000 |
| 2 | 2000 | 2 s | 7000 |
| 3 | 4000 | 4 s | 9000 |
| 4 | 8000 | 8 s | 13000 |
| 5 | 16000 | — | dead; the fifth failure does not reschedule |
| 6 | 32000 | 32 s | (only if \`MAX_ATTEMPTS\` were higher) |
| 7, 8, … | 64000, 128000 | 60 s | the cap holds |

- **Exponential** so that total pressure on a struggling dependency falls off quickly: ten thousand
  jobs that failed together retry at 1 s, then half as often, then a quarter.
- **Capped** because an uncapped exponent is absurd by the tenth attempt (over 8 minutes) and
  catastrophic by the twentieth (6 days).
- **Attempt-indexed, not time-indexed.** The delay depends on how many times *this* job has failed,
  which is why the count lives in \`jobs:attempts\` and the script returns it alongside the payload.

:::widget deadline-retry {"base": 1000, "deadline": 60000, "attempts": 5}

What the drill leaves out — and the AWS post is mostly about — is **jitter**: randomising each delay
(their "full jitter" picks uniformly from \`0 … backoff\`) so that jobs that failed together do not
retry together. Without it, a provider that fell over at \`t\` sees the same spike at \`t + 1 s\`,
\`t + 3 s\`, \`t + 7 s\`; Sidekiq adds \`rand(10) × (count + 1)\` seconds to every retry for exactly that reason.

:::quiz
Q: A mail provider has been down for two minutes. Which retry policy sends it the fewest requests while it recovers?
- [ ] Retry every second until it answers
- [x] Double the wait per attempt, capped, with jitter
- [ ] Retry once after a fixed 60 s
> Fixed one-second retries hammer a dependency exactly when it cannot cope. Doubling halves the pressure each round; the cap keeps the longest wait sane; jitter spreads out the jobs that all failed at the same instant so they do not all come back at the same instant.
:::

# Not forever: the dead list

A retry policy without a ceiling is a leak: a job whose payload is malformed, or whose recipient
no longer exists, fails every time and will fail at 60 s intervals until someone notices the graph.
\`fail\` therefore counts first and decides second:

:::sequence
{
  "participants": ["worker", "Redis"],
  "messages": [
    {"from": "worker", "to": "Redis", "label": "HINCRBY jobs:attempts j1 1", "kind": "sync"},
    {"from": "Redis", "to": "worker", "label": "4 — below MAX_ATTEMPTS", "kind": "reply"},
    {"from": "worker", "to": "Redis", "label": "ZADD jobs:delayed 13000 j1 — now 5000 + backoff_ms(4) = 8000", "kind": "sync"},
    {"from": "worker", "to": "Redis", "label": "… pop at 13000, run, fail again: HINCRBY jobs:attempts j1 1", "kind": "sync"},
    {"from": "Redis", "to": "worker", "label": "5 — MAX_ATTEMPTS reached", "kind": "reply"},
    {"from": "worker", "to": "Redis", "label": "RPUSH jobs:dead j1 · HDEL jobs:attempts j1 — payload kept", "kind": "sync"}
  ]
}
:::

| After \`HINCRBY\` returns | \`fail\` does | Returns |
| --- | --- | --- |
| \`attempt < 5\` | \`ZADD jobs:delayed (now_ms + backoff_ms(attempt)) job_id\` | the new \`run_at_ms\` |
| \`attempt >= 5\` | \`RPUSH jobs:dead job_id\` · \`HDEL jobs:attempts job_id\` | nothing |

- **One command counts and reads:** \`HINCRBY\` creates the field at 1 the first time and returns the
  new value, so there is no get-then-set on the count.
- **Compare before computing a delay.** The fifth failure is not "reschedule at 16 s"; it is the end.
- **The payload stays.** \`jobs:dead\` holds ids; \`jobs:payload\` still has what the job was, so an
  operator can read it, fix the cause, and \`schedule\` it again — or \`complete\` it to discard it.
- **The count goes.** Dropping \`jobs:attempts\` on death means a re-scheduled dead job starts its
  retries from one.
- **A list, not a set.** \`RPUSH\` keeps arrival order, so \`LRANGE jobs:dead 0 -1\` reads as a log of
  what died and when (relative to its neighbours).

This is the queue-side form of a
[dead-letter queue](https://en.wikipedia.org/wiki/Dead_letter_queue): the job leaves the hot path but
not the system, and its leaving is observable — a growing \`LLEN jobs:dead\` is an alert.

:::quiz
Q: Why does \`fail\` leave the payload in \`jobs:payload\` when it moves an id to \`jobs:dead\`?
- [ ] Deleting from a hash is slow and the worker is on the critical path
- [x] So the dead job can be inspected and re-scheduled; the id alone says nothing about what failed
- [ ] Because \`complete\` will delete it later anyway
> The dead list exists for a human. An id with no payload is a line in a log; an id whose payload is still readable is something that can be diagnosed, fixed and put back. complete is the explicit "discard it" and is never called on a dead job automatically.
:::

# The worker that dies with a job in hand

The atomic pop guarantees a job is handed to *at most one* worker. It says nothing about what that
worker does next — and if the process is killed after \`pop_due\` returns and before \`complete\` or
\`fail\` runs, the job is in no structure that anyone polls:

:::sequence
{
  "participants": ["worker A", "Redis", "worker B"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "EVAL pop · now 5000", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "[(j1, {…}, 0)] — j1 removed from jobs:delayed", "kind": "reply"},
    {"from": "worker A", "to": "worker A", "label": "sending email … OOM-killed", "kind": "sync"},
    {"from": "worker B", "to": "Redis", "label": "EVAL pop · now 5000, 6000, 60000 …", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "[] — j1 is in jobs:payload only; nobody will ever see it", "kind": "reply"}
  ]
}
:::

The drill's pop is **at-most-once** delivery: no duplicate, but a crash loses the job. Real systems
make it at-least-once by never letting a job be in *no* set:

- **A processing set.** Instead of \`ZREM\`, the script moves the id into a second sorted set —
  \`jobs:processing\`, scored by the time it was claimed (Sidekiq's "super_fetch" keeps a per-process
  working list; BullMQ keeps an \`active\` list; SQS calls the idea a *visibility timeout*).
- **A reaper.** Periodically, \`ZRANGEBYSCORE jobs:processing -inf (now − timeout)\` finds claims
  older than the visibility timeout — a worker that has not finished in, say, 30 s is presumed dead —
  and moves them back to \`jobs:delayed\`, counting it as a failure.
- **Finishing ends the claim:** \`complete\` and \`fail\` remove the id from processing. Finishing the job is what ends the claim, not
  starting it.

The price is that the job may now run **twice**: a worker that was slow rather than dead finishes
after the reaper re-queued its job. That is why job handlers in these systems are expected to be
idempotent, and why "exactly-once" job execution is a property of the handler, never of the queue.

:::widget delivery-semantics {}

:::quiz
Q: A worker pops \`j1\` and is killed before calling \`complete\` or \`fail\`. In the drill as built, where is \`j1\`?
- [ ] Back in \`jobs:delayed\`, because the claim expired
- [ ] In \`jobs:dead\`, because the worker never acknowledged it
- [x] Only in \`jobs:payload\`; no worker will pop it again
> ZREM inside the script took j1 out of the only key that pop_due reads. Nothing in the drill puts it back: that is the processing-set-plus-reaper the statement leaves out, and it turns at-most-once into at-least-once at the cost of possible duplicates.
:::

# What to take away

- **A sorted set scored by due time is a timer.** \`ZADD\` schedules, \`ZRANGEBYSCORE -inf now\` is "what
  is due", and a reschedule is a score update because the member is the id, not the job.
- **Read-then-remove from the client is a race.** Two round trips leave a window; every worker
  polling in it runs the same job. The claim must be one indivisible step.
- **A Lua script is Redis's compare-and-swap.** \`ZRANGEBYSCORE\`, \`ZREM\` and the \`HGET\`s run with
  nothing interleaved, so a returned id is a claimed id.
- **Double, cap, stop.** \`min(1000 × 2^(attempt − 1), 60000)\`, and after the fifth failure a dead list
  — with the payload kept for whoever has to look.
- **Atomic pop is at-most-once.** A worker that dies holding a job loses it; a processing set with a
  visibility timeout and a reaper buys at-least-once, and idempotent handlers pay for the duplicates.

The primary reference is the Redis
[sorted-set documentation](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — the data
type, its range commands and the \`O(log N)\` claims the design leans on — with AWS's
[*Exponential Backoff and Jitter*](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
(Marc Brooker, 2015) for the retry arithmetic the drill keeps and the jitter it leaves out.
`;
