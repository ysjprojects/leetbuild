import type {Source} from '@/lib/types';

/**
 * The failure-mode guide for leases, claims and fencing: work one worker owns for a while, and what
 * happens when that worker stops, stalls or comes back late. Rendered at `/guides/leases`.
 */
export const guide = `# The failure mode

A queue hands a job to a worker. The worker runs it, then says it is done. Between those two moments
the job belongs to that worker, and everything that can go wrong with ownership goes wrong there:

- The worker **dies** holding the job. If the claim has no deadline, the job is held forever.
- The worker **stalls** (a garbage-collection pause, a swap storm, a partition) past its deadline.
  The job is handed to a second worker, and the first one wakes up still believing it owns it.
- A **second party** moves the claim: another worker extends it, another reaper returns it, another
  caller releases it.
- The worker **fails** halfway and never gives the claim back, so the slot it held stays taken until
  someone notices.

A claim that is meant to survive a crash is a **lease**: ownership with a deadline, renewable only
by the holder, returned exactly once when the deadline passes, and checked on the way out so that a
holder who was replaced cannot finish the work anyway.

The smallest instance is a job queue in Redis:

\`\`\`python
def claim(worker):
    job = r.lpop("jobs:queue")                                   # 1. take it off the queue
    if job is None:
        return None
    r.zadd("jobs:inflight", {job: now() + VISIBILITY_TIMEOUT_S})  # 2. remember the deadline
    r.hset(f"job:{job}", mapping={"state": "running", "worker": worker})
    return job

def ack(job, worker):
    r.hset(f"job:{job}", "state", "completed")                    # whoever asks
\`\`\`

It works in every demo. It has three holes: a crash between lines 1 and 2 loses the job with no
trace; a worker whose deadline passed and whose job went to someone else can still \`ack\` it; and the
acknowledged job stays in \`jobs:inflight\`, so when its deadline passes the reaper runs it again.

# How it shows up

The debugging courses that hold work for a while all start from a version of this:

- [Job Queue, step 2](/job-queue/2-state): the visibility timeout. The starter pops and records the
  deadline in separate round trips, two reapers that see one expired claim both requeue it, and an
  acknowledged job stays in \`jobs:inflight\` until it is run a second time.
- [Batch Inference Service, step 2](/batch-inference/2-state): shard leases with claim, heartbeat,
  complete and reap. The heartbeat does not look at the owner, the reaper marks a dead worker's
  shard \`failed\` instead of handing it back, and the worker the reaper replaced can still complete.
- [Moderation Service, step 2](/moderation-service/2-state): a case claimed by a moderator whose
  browser crashed is held forever, one moderator extends a case another holds, and a swept case is
  swept again on every pass.
- [Vision Inference, step 2](/vision-inference/2-state): GPU slots as a sorted set. Members are
  scored by admission time instead of by lease expiry, so a crashed holder's slot never ages out,
  and release removes the lowest-ranked member rather than the caller's ticket.
- [Sandbox Runner, step 2](/sandbox-runner/2-state): the runner trusts its own memory of when the
  lease started, so an operator who shortens it is ignored, and a result that arrives after the
  lease expired is published anyway.
- [Ticketing System, step 2](/ticketing-system/2-state): one agent puts down a ticket another one
  holds, because \`release\` deletes the lease without asking whose it is.
- [Media Transcoder, step 2](/media-transcoder/2-state): a segment claim without an expiry is held
  forever by a crashed worker, and a claim is not released when the encode raises.
- [Recommendation Ranking, step 2](/recommendation-ranking/2-state): a single-flight refresh under
  a lock, where the lock has to be released on the failure path too.

The symptoms rhyme across all of them: **work that disappears** (popped, never leased), **work done
twice** (two holders, or a done job that comes back), **work stuck** (a claim nobody will ever
release), and **a result from a worker that no longer owned the job**.

:::quiz
Q: A job's visibility timeout is 60 s. The worker that claimed it is paused for 90 s, the job is handed to a second worker, and the first worker wakes up and acknowledges it. What should the acknowledgement do?
- [ ] Succeed: the work was done, and doing it is what matters
- [x] Be refused, because the job is no longer that worker's; only the current holder's acknowledgement counts
- [ ] Succeed and cancel the second worker
> After the hand-over the job has one owner, and it is not the first worker. Accepting its acknowledgement can mark the job done while the second worker is mid-run, or record the first worker's stale output over the second's. The first worker learns it was replaced by being refused.
:::

# The mechanism

## A claim is a deadline, written in the same step as the take

A lease is two facts that must appear together: **who** holds the work and **until when**. In Redis
the deadline usually lives in a sorted set scored by it (\`ZADD jobs:inflight <deadline> <id>\`), so
"what expired" is one range query, and the owner lives beside it in a hash. The take and both facts
are one Lua script, so no crash can land between them:

\`\`\`lua
-- claim: KEYS = jobs:queue, jobs:inflight, jobs:owner, jobs:epoch
-- ARGV = now_ms, lease_ms, worker
local id = redis.call('LPOP', KEYS[1])
if not id then return false end
local token = redis.call('HINCRBY', KEYS[4], id, 1)          -- the fencing token
redis.call('ZADD', KEYS[2], tonumber(ARGV[1]) + tonumber(ARGV[2]), id)
redis.call('HSET', KEYS[3], id, ARGV[3] .. ':' .. token)      -- owner = worker:token
return {id, token}
\`\`\`

A claim on a single key is the same idea in one command: \`SET lease:{id} <owner> NX PX 90000\`
takes the key only if it is free and gives it its expiry in the same write. \`SET NX\` followed by
\`EXPIRE\` is the bug the [Sandbox Runner](/sandbox-runner/2-state) starter ships: a runner that dies
between them leaves a lease that never expires.

## Renewal only by the holder, checked in the same script

A long job heartbeats: it pushes its deadline forward while it is still alive. The renewal compares
the owner and moves the deadline in one script; a comparison in the client followed by a \`ZADD\` is a
check-then-act race, and a renewal that does not compare at all lets anyone keep anyone's job.

\`\`\`lua
-- renew: KEYS = jobs:inflight, jobs:owner   ARGV = id, worker:token, now_ms, lease_ms
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
local deadline = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]) or 0)
if deadline <= tonumber(ARGV[3]) then return 0 end            -- already expired: too late
redis.call('ZADD', KEYS[1], 'XX', tonumber(ARGV[3]) + tonumber(ARGV[4]), ARGV[1])
return 1
\`\`\`

The second test matters as much as the first. A lease whose deadline has passed is **already
gone**, even if the reaper has not run yet; renewing it would let a worker resurrect a claim the
reaper may hand out a millisecond later. A worker whose renewal is refused stops working.

## Reaping once, guarded by the removal

The reaper finds the claims whose deadline passed and puts them back. Two reapers (or a reaper and
a late acknowledgement) will look at the same expired claim. The rule that keeps the hand-back
single is: **whoever removes the claim hands it back**, and the removal answers whether you were
that one.

\`\`\`lua
-- reap: KEYS = jobs:inflight, jobs:owner, jobs:queue   ARGV = now_ms
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 100)
local n = 0
for _, id in ipairs(due) do
  if redis.call('ZREM', KEYS[1], id) == 1 then                -- I removed it, so I return it
    redis.call('HDEL', KEYS[2], id)
    redis.call('RPUSH', KEYS[3], id)
    n = n + 1
  end
end
return n
\`\`\`

Inside one script nothing else runs between the range and the removal, so every \`ZREM\` returns 1.
The guard is what keeps a reaper that runs in the client correct: \`ZRANGEBYSCORE\`, then one \`ZREM\`
per id, then \`RPUSH\` **only** when that \`ZREM\` returned 1. The losing reaper sees 0 and moves on.
The same guard sits in the acknowledgement: an \`ack\` that \`ZREM\`s the job from \`jobs:inflight\` and
gets 0 knows the claim is gone, and answers false.

An expired claim goes **back to the queue**, not to \`failed\`: the worker died, the job did not. A
dead-letter decision belongs to an attempt counter, not to one missed deadline.

## Fencing: the holder proves it is still the holder

A deadline guarantees that a dead worker's job comes back. It cannot guarantee that the old worker
is dead. Nothing stops a paused process from resuming after its lease expired and finishing the job
it no longer owns:

:::sequence
{
  "participants": ["Worker A", "Redis", "Worker B", "Output store"],
  "messages": [
    {"from": "Worker A", "to": "Redis", "label": "claim shard 7 · lease 30 s", "kind": "sync"},
    {"from": "Redis", "to": "Worker A", "label": "shard 7, token 33, deadline t+30", "kind": "reply"},
    {"from": "Worker A", "to": "Worker A", "label": "GC pause 40 s: no heartbeat, A still thinks it owns 7"},
    {"from": "Worker B", "to": "Redis", "label": "reap at t+31 · ZREM shard 7 → 1 → RPUSH", "kind": "sync"},
    {"from": "Worker B", "to": "Redis", "label": "claim", "kind": "sync"},
    {"from": "Redis", "to": "Worker B", "label": "shard 7, token 34", "kind": "reply"},
    {"from": "Worker B", "to": "Output store", "label": "write shard 7 · token 34", "kind": "sync"},
    {"from": "Output store", "to": "Worker B", "label": "ok, highest token is now 34", "kind": "reply"},
    {"from": "Worker A", "to": "Output store", "label": "write shard 7 · token 33 (A wakes up)", "kind": "sync"},
    {"from": "Output store", "to": "Worker A", "label": "refused: 33 < 34", "kind": "reply"},
    {"from": "Worker A", "to": "Redis", "label": "complete shard 7 as A:33", "kind": "sync"},
    {"from": "Redis", "to": "Worker A", "label": "0: the owner is B:34", "kind": "reply"}
  ]
}
:::

The fencing token is a number that grows with every claim of the same work (\`HINCRBY jobs:epoch\`
above, a ZooKeeper znode version, a database row version). The holder passes it with every effect,
and whatever receives the effect refuses a token lower than the highest it has seen:

\`\`\`sql
UPDATE shard_output
   SET body = $1, token = $2
 WHERE shard_id = $3 AND token < $2;    -- 0 rows: a newer holder already wrote
\`\`\`

For effects that stay inside Redis, the owner check in \`complete\` is the fence: the stored owner is
\`worker:token\`, and a completion from \`A:33\` when the owner is \`B:34\` changes nothing.

\`\`\`lua
-- complete: KEYS = jobs:inflight, jobs:owner, jobs:outcome   ARGV = id, worker:token, outcome
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])                          -- no deadline left behind
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
return 1
\`\`\`

:::details Why "check the lease, then write" is not a fence
The tempting fix is to ask "is my lease still valid?" right before the write. It narrows the window
and does not close it: the pause can land between the check and the write, and a write already sent
can sit in a network buffer while the lease expires. Kleppmann's point is that no amount of checking
on the worker's side helps; the refusal has to happen at the **receiver**, which compares the token
it is given against the highest it has accepted. A worker-side check is still worth doing, as an
early exit, but it is an optimisation, not a guarantee.
:::

:::quiz
Q: The reaper runs in the client: \`ZRANGEBYSCORE jobs:inflight -inf now\`, then for each id \`RPUSH jobs:queue id\` and \`ZREM jobs:inflight id\`. Two reaper processes run at once. What goes wrong, and what is the smallest fix?
- [ ] Nothing: \`ZREM\` of a missing member is harmless
- [ ] Each reaper should take a global lock first
- [x] Both see the same expired id and both push it, so two workers run it; push only when your own \`ZREM\` returned 1
> The range read is a snapshot both reapers share. The removal is the one operation only one of them can win, so it is the operation that decides who hands the job back. A global lock would also work, at the price of a second lease to get right.
:::

## Releasing on every path

A lease that is released by the normal path only is released by the normal path only. The failure
path is the one that runs when something has already gone wrong, so it is the one most likely to
leak a slot:

\`\`\`python
token = secrets.token_hex(16)
if not r.set(lock_key, token, nx=True, ex=LOCK_TTL_S):
    return stale_copy_or_none()              # someone else is refreshing
try:
    values = feature_service.user_features(tenant, user_id)
    write_back(values)
    return values
finally:
    release_if_mine(keys=[lock_key], args=[token])   # compare-and-delete, success or not
\`\`\`

\`release_if_mine\` is the four-line script from the Redis docs (\`GET\`, compare, \`DEL\`), or
\`DELEX key IFEQ token\` on Redis 8.4 and later. A plain \`DEL\` in the \`finally\` would delete the
lock of whoever took it after yours expired. The expiry is still there as the backstop for the path
\`finally\` cannot cover: the process killed outright.

The same goes for counted slots. A GPU slot taken with a ticket must be given back by that ticket
(\`ZREM gpu:{tenant} <ticket>\`), from a \`finally\`, and the set must be scored by the lease's end
so that \`ZREMRANGEBYSCORE gpu:{tenant} -inf now\` returns a crashed holder's slot.

:::details Whose clock is "now"?
Every script above takes \`now_ms\` as an argument. That keeps the scripts testable (the test owns
the clock) and keeps Redis replication deterministic, but it lets each worker judge expiry by its own
clock: a worker running 5 s fast reaps leases 5 s early. Two ways to tighten it: let the script read
\`redis.call('TIME')\` so one server clock decides every deadline (fine since Redis 5, where scripts
replicate their effects), or keep the argument and size the lease so that clock skew is a small
fraction of it. Either way, a lease's safety must not depend on clocks agreeing; that is what the
fencing token is for. Redis itself expires keys by wall-clock time, so a stepped server clock can
expire a lease early.
:::

# Leases versus locks

A lock says "only one at a time". A lease says "only one at a time, **until a deadline**". In a
single process a lock is enough, because the holder cannot vanish while the lock outlives it. Across
machines the holder can vanish, so every useful distributed lock is a lease, and inherits a lease's
problem: expiry is decided by time, and time cannot tell a dead holder from a slow one.

| | Lock (in one process) | Lease (across machines) |
| --- | --- | --- |
| Holder crashes | the lock dies with the process | the deadline returns the work |
| Holder stalls | everyone waits | the work moves on; the stalled holder must be fenced |
| Release | by the holder | by the holder, compared by token, or by expiry |
| Renewal | not needed | a heartbeat, only by the holder, refused once expired |
| What it guarantees | mutual exclusion | mutual exclusion **while clocks and pauses behave**, plus fencing for when they do not |

Kleppmann's distinction decides how much of this you need. A lock **for efficiency** (one refresh
instead of fifty, as in a single-flight cache fill) can fail now and then: the cost is a duplicate
call. A single Redis key with \`SET NX PX\` and a compare-and-delete is enough. A lock **for
correctness** (one charge, one file write, one encoded segment in a manifest) cannot: it needs the
fencing token checked by the resource, because no lease alone is safe against a pause.

:::quiz
Q: A cache refresh takes \`SET lock:features:t1:u9 1 NX EX 5\` so that one caller refreshes a cold key while the others serve the stale copy. Which of these is a real flaw?
- [ ] The lock has no fencing token
- [x] The lock is released only after a successful refresh, so a failed refresh leaves every caller waiting 5 s
- [ ] The lock should be taken with Redlock across five Redis nodes
> This lock is for efficiency: if it fails, two callers refresh, which costs one extra call. Fencing and Redlock buy nothing here. The flaw is the missing release on the failure path: until the 5 s expiry nobody refreshes, and the failure that broke the first refresh is the one most likely to persist. Release from a \`finally\`, compared against your value.
:::

# The fix and its trade-offs

The pattern, whatever stores it:

1. **Claim with a deadline**, take and record in one step: one script, or \`SET … NX PX\`.
2. **Renew only as the holder**, compared in the same script as the move, and never after the
   deadline.
3. **Reap by removal**: whoever removes the expired claim hands it back, to the queue, once.
4. **Fence the exit**: completion and any external effect carry the token; the receiver refuses
   an older one.
5. **Release on every path**, compared by token, from a \`finally\`; leave the expiry as the
   backstop.
6. **Leave nothing behind**: completion removes the deadline, so the reaper cannot find a finished
   job.

What it costs:

- **Lease length is a trade.** Short leases return a dead worker's work quickly and turn every slow
  worker into a duplicate; long leases do the opposite. A heartbeat lets the lease be short and the
  job long, at the price of one write per interval per job. SQS's guidance is the same: start with a
  timeout close to the typical processing time and extend it while processing.
- **Fencing needs the receiver's help.** A store that cannot compare a token (an email provider, a
  payment API) cannot be fenced; there the fallback is an idempotency key the provider honours, so
  the duplicate effect is at least collapsed.
- **At-least-once is the honest promise.** A lease turns "lost" into "maybe done twice". The work
  behind it has to tolerate a second run (idempotent writes, a dedupe key), because a worker can
  finish its effect and die before it completes the lease.
- **One Redis is one point of truth.** A single instance with async replication can lose a lease on
  failover and grant it twice. For efficiency locks that is acceptable; for correctness, the fence
  is what makes it acceptable.

:::details Leases you meet that are not called leases
An SQS message's visibility timeout is a lease the queue manages: \`ReceiveMessage\` claims,
\`ChangeMessageVisibility\` renews, \`DeleteMessage\` completes, and the timeout reaps. A Kafka
consumer group's session timeout is a lease on partitions. A reservation hold in a booking system
(a seat held for 900 s while the payment runs) is a lease on stock, and has the same bugs: a hold
that never expires, a hold released by someone else, a hold released twice.
:::

# Proving it: a paused worker on a virtual clock

A lease bug only shows when time passes at the wrong moment, so the test must own time. Every
operation takes \`now\` from a clock the test advances; nothing sleeps. Then the paused worker is not
a thread you hope will be slow enough: it is a worker that simply makes no call while the test moves
the clock past its deadline.

\`\`\`python
def test_a_paused_worker_is_replaced_and_fenced(r):
    clock = FakeClock(start_ms=1_000_000)
    q = ShardQueue(r, now=clock.now, lease_ms=30_000)
    q.enqueue("shard-7")

    a = q.claim("A")                          # token 1, deadline 1_030_000
    clock.advance(31_000)                     # A is paused: no heartbeat, no call
    assert q.reap() == 1                      # handed back once
    assert q.reap() == 0                      # and not twice
    b = q.claim("B")
    assert (b.id, b.token) == ("shard-7", 2)

    assert q.renew(a) is False                # A wakes up: no renewal
    assert q.complete(a, "done") is False     # and no completion
    assert q.complete(b, "done") is True

    assert q.outcome("shard-7") == "done"
    assert r.zcard("jobs:inflight") == 0      # no deadline left behind
    assert r.llen("jobs:queue") == 0          # nothing will run it again
    clock.advance(60_000)
    assert q.reap() == 0
\`\`\`

Then the paths around it:

- **Renew before and after the deadline.** At \`deadline - 1\` the holder's renewal succeeds and the
  deadline moves; at \`deadline\` it is refused, even though the reaper has not run.
- **Renew by someone else.** B's renewal of A's live lease answers false and leaves A's deadline
  where it was.
- **Two reapers.** Run the client-side reaper's steps interleaved by hand: both read the range, both
  try to remove; assert exactly one push.
- **Crash inside the claim.** Fail the connection between the take and the deadline (a fake that
  raises after \`LPOP\`) and assert the job is in the queue or in flight, never in neither. With one
  script this passes trivially, which is the point.
- **Release on the error path.** Make the dependency raise inside the \`try\`, then assert the lock
  key is gone, and that a second caller can take it without waiting for the expiry.
- **Release by a stranger.** Take the lock as A, let it expire, take it as B, release as A; assert
  B still holds it.

Assert **outcomes**: who owns the work, what the store holds, how many times the work ran. A test
that greps the script for \`ZREM\`, or that sleeps 31 real seconds and passes because the machine was
fast, proves nothing about the next pause.

:::quiz
Q: Which test catches a heartbeat that renews without comparing the owner?
- [ ] Claim as A, renew as A, assert the renewal returns true
- [x] Claim as A, renew as B, assert it returns false and A's deadline did not move; then advance past A's deadline and assert the job is reaped
- [ ] Assert the renew script contains \`HGET\`
> The happy path passes either way. The flawed heartbeat lets B keep A's job alive, so the deadline moves and the reaper never returns the job. Only a stranger's renewal, followed by the clock moving past the original deadline, shows the difference in an outcome.
:::
`;

export const sources: Source[] = [
  {
    title: 'How to do distributed locking',
    url: 'https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html',
    by: 'Martin Kleppmann',
    date: '2016-02-08',
    kind: 'post',
    venue: "Martin Kleppmann's blog",
    takes:
      'The paused client whose lease expires mid-write, fencing tokens checked by the storage service, and the split between locks for efficiency and locks for correctness.',
  },
  {
    title: 'Distributed Locks with Redis',
    url: 'https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/',
    kind: 'docs',
    venue: 'Redis docs',
    takes:
      'SET NX PX with a unique value, release by compare-and-delete (the Lua script or DELEX IFEQ), extension only while the value is still yours, and the warning that Redis expiry follows the wall clock.',
  },
  {
    title: 'Amazon SQS visibility timeout',
    url: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html',
    kind: 'docs',
    venue: 'Amazon SQS Developer Guide',
    takes:
      'A received message as a lease: invisible while in flight, extended by a heartbeat through ChangeMessageVisibility, visible again when the timeout passes, and never a guarantee against a second delivery.',
  },
  {
    title: 'The Chubby lock service for loosely-coupled distributed systems',
    url: 'https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/',
    by: 'Mike Burrows',
    kind: 'paper',
    venue: 'OSDI 2006',
    takes:
      'Sequencers: the lock generation number a holder passes to the servers it calls, which check it and reject a request from a holder that lost the lock.',
  },
];
