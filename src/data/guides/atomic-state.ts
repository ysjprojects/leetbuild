import type {Source} from '@/lib/types';

/**
 * The atomic-state guide: a read, a comparison and a write sent as separate commands, why two
 * clients interleave between them, and the single commands, scripts and compare-and-sets that make
 * the decision one step. Rendered at `/guides/atomic-state`.
 */
export const guide = `# Two clients, one budget

A tenant has 100 credits left for the day. Two requests arrive together, each costing 60. The code
that guards the budget reads naturally:

\`\`\`python
remaining = int(r.get(key) or 0)
if remaining < cost:
    return refuse()
r.decrby(key, cost)
return admit()
\`\`\`

Run it with one client and it is correct every time. Run it with two and this happens:

:::sequence
{
  "participants": ["client A", "client B", "Redis"],
  "messages": [
    {"from": "client A", "to": "Redis", "label": "GET budget:acme", "kind": "sync"},
    {"from": "Redis", "to": "client A", "label": "100", "kind": "reply"},
    {"from": "client B", "to": "Redis", "label": "GET budget:acme", "kind": "sync"},
    {"from": "Redis", "to": "client B", "label": "100", "kind": "reply"},
    {"from": "client A", "to": "client A", "label": "100 ≥ 60 → admit", "kind": "sync"},
    {"from": "client B", "to": "client B", "label": "100 ≥ 60 → admit", "kind": "sync"},
    {"from": "client A", "to": "Redis", "label": "DECRBY budget:acme 60", "kind": "sync"},
    {"from": "Redis", "to": "client A", "label": "40", "kind": "reply"},
    {"from": "client B", "to": "Redis", "label": "DECRBY budget:acme 60", "kind": "sync"},
    {"from": "Redis", "to": "client B", "label": "-20", "kind": "reply"}
  ]
}
:::

Every command was atomic. **The decision was not.** Client B compared against a value that was
already out of date by the time it acted, so both requests passed a check only one of them could
pass, and the budget ended at -20. This is the *check-then-act* race (in operating-system terms,
time-of-check to time-of-use): a read, a comparison in the client, and a write that depends on the
comparison, sent as separate round trips.

The same shape hides behind many different features:

| The decision | The starter's round trips | What two racing clients get |
| --- | --- | --- |
| Take the last unit, slot or seat | \`HGET\` the slot, then \`HSET\` it | Both hold it |
| Claim an email address or a ballot | \`EXISTS\`, then \`SET\` | Two owners, two votes |
| Spend from a window or budget | \`GET\` the count, compare, \`INCRBY\` | The limit overshot |
| Move an offset or a pointer forward | \`GET\`, compare, \`SET\` | The older value wins last |
| Advance a workflow one step | \`HGET\` the step, then \`HSET\` the next | A step runs twice or is skipped |
| Record, then report the totals | \`HINCRBY\` ×4, then \`HGETALL\` | Totals that include the other request |

# How it shows up in the courses

Almost every debugging course has a Redis step whose starter makes one of these decisions in
several round trips. A few to practise on, each with the symptom a reviewer would see:

- [Booking Engine, step 2](/booking-engine/2-state): two customers booking the same slot at the same
  moment both get a hold, and the one who pays second finds the slot booked by someone else.
- [Inventory Service, step 2](/inventory-service/2-state): the last unit is sold twice, and the
  available count drops below zero.
- [AI Cost Meter, step 2](/cost-meter/2-state): two concurrent reports each come back with the
  other one's tokens in their totals.
- [CDN Purge, step 2](/cdn-purge/2-state): two reservations for the same path both win, and a
  reservation that is refused still uses up part of the window's budget.
- [Feedback Collector, step 2](/feedback-collector/2-state): a double click records two ballots for
  one user and one request.
- [Identity Service, step 2](/identity-service/2-state): two sign-ups with the same address both
  succeed, and the address ends up with two owners.
- [Geo Replicator, step 2](/replicator/2-state): a delayed writer moves a shard's offset backwards,
  and the shard replays what it already applied.
- [Workflow Engine, step 2](/workflow-engine/2-state): two workers finishing the same step both
  advance the checkpoint.

None of these show up in a demo with one user. When you read a starter, look for these patterns:

- A client call whose reply feeds an \`if\` that guards another client call on the same key.
- An \`await\` (or a goroutine boundary, or a thread) between reading a value and writing what was
  computed from it.
- A write followed by a read that reports "the total": the read may include someone else's write.
- A charge followed by a compensating refund when the charge turns out to be too much.
- Several writes that must all happen together (append, trim, expire) sent as separate commands, so
  a crash or a reader can land between them.

:::quiz
Q: A starter calls \`r.exists(key)\` and, when it returns 0, calls \`r.set(key, user)\`. Its single-user test passes. What does a concurrent test with two users and the same key show?
- [ ] One \`SET\` fails, because Redis refuses to overwrite a key that was just created
- [x] Both calls can see 0 from \`EXISTS\`, both \`SET\` succeed, and the second user silently overwrites the first
- [ ] Redis serializes both clients' commands, so the second \`EXISTS\` always sees the first \`SET\`
> Redis runs one command at a time, but it runs them in arrival order across all clients. Two \`EXISTS\` can both arrive before either \`SET\`. A plain \`SET\` overwrites without complaint, so nothing fails. The bug only shows up as a second owner.
:::

# Why two round trips interleave

Redis runs commands on one thread, one at a time. Each command is atomic: no other client sees half
of an \`INCRBY\` or half of an \`HSET\` with three fields. Nothing is atomic *between* two commands
from the same client. While your reply travels back, the client parses it, compares, and sends the
next command, Redis keeps serving everybody else.

The window is wider than it looks:

- **Round trips.** A same-zone round trip is a fraction of a millisecond. At a few thousand requests
  a second on a hot key, a fraction of a millisecond is enough for another request to get in.
- **Pauses.** A garbage-collection pause, a scheduler preemption or a slow network packet stretches
  the gap to tens of milliseconds at exactly the wrong moment.
- **Concurrency inside one process.** Node's event loop runs another request at every \`await\`.
  Python's asyncio does the same, and goroutines and thread pools run truly in parallel. You do not
  need two servers to race.
- **Many servers.** Production runs several replicas behind a load balancer, so even a perfectly
  serial process has peers.

Pipelining does not close the window. A pipeline sends several commands without waiting for each
reply, but Redis may still run other clients' commands between them. Also, a pipeline cannot branch:
the \`DECRBY\` is already sent before the \`GET\` reply arrives, so the comparison cannot stop it.

:::details Why Redis can promise a script runs atomically
A script runs on the same single thread as every command, and the server serves nobody else until
it returns. All of its effects have either not happened yet or have all happened. That is the whole
guarantee, and it has a cost: a slow script blocks every client. Keep scripts short and bounded: no
loops over unbounded collections, no waiting. \`SCRIPT KILL\` can only stop a script that has not
written yet, because stopping one halfway would break the atomicity it promised.
:::

# Fix 1: one command, when one exists

The cheapest fix is a command that already makes the decision on the server. Many common decisions
have one:

| Decision | One command | Reply that carries the decision |
| --- | --- | --- |
| Claim if nobody holds it, with a lifetime | \`SET key owner NX EX 30\` | \`OK\` or nil |
| Add and learn the new total | \`INCRBY\` / \`HINCRBY\` | the new value |
| Add a member only once | \`SADD\` / \`ZADD NX\` | 1 or 0 added |
| Take the next item | \`LPOP\`, \`ZPOPMIN\`, \`LMOVE\` | the item, or nil |
| Replace only the expected value (Redis 8.4+) | \`SET key new IFEQ old\` | \`OK\` or nil |

The claim is the most common case, and every client spells it differently:

\`\`\`python
won = r.set(ballot_key, vote, nx=True, ex=30 * 86400)   # True, or None when taken
\`\`\`

\`\`\`typescript
const won = (await redis.set(ballotKey, vote, 'EX', 30 * 86400, 'NX')) === 'OK';
\`\`\`

\`\`\`go
won, err := rdb.SetNX(ctx, ballotKey, vote, 30*24*time.Hour).Result()
\`\`\`

\`\`\`cpp
bool won = redis.set(ballot_key, vote, std::chrono::hours(30 * 24), sw::redis::UpdateType::NOT_EXIST);
\`\`\`

\`\`\`scala
val won = jedis.set(ballotKey, vote, SetParams.setParams().nx().ex(30L * 86400)) == "OK"
\`\`\`

Two details matter. First, the expiry goes **in the same command**: \`SETNX\` followed by
\`EXPIRE\` leaves a key that lives forever if the process dies between the two (see
[keys and lifetimes](/guides/keys-and-expiry)). Second, **use the reply**. \`INCRBY\` returns the
new total, so a meter that flags overage can decide from that reply. It must not issue a separate
\`GET\`.

\`INCRBY\` first and compare afterwards is fine when the effect is "count it and flag it". It is wrong
when the effect is "refuse and charge nothing": by the time you compare, the charge has already
happened.

# Fix 2: a Lua script for a decision with several steps

When the decision needs a read, a comparison and several writes, put all three on the server. The
budget from the first section becomes:

\`\`\`lua
-- KEYS[1] budget:{acme}:2026-11-12   ARGV[1] cost   ARGV[2] limit   ARGV[3] ttl seconds
local used  = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost  = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if used + cost > limit then
  return {0, used, redis.call('TTL', KEYS[1])}       -- refused: nothing written
end
used = redis.call('INCRBY', KEYS[1], cost)
if used == cost then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return {1, used, redis.call('TTL', KEYS[1])}         -- the script's own totals
\`\`\`

What makes this script correct, beyond running atomically:

- **Every key arrives in \`KEYS\`, every value in \`ARGV\`.** The script never builds a key name
  itself. In Redis Cluster all keys of one script must share a hash slot, which the \`{acme}\` hash
  tag guarantees. The script text never changes, so it has one SHA1 and the server compiles it once.
  Formatting the cost into the script source instead would fill the script cache with a new script
  for every request.
- **A refusal returns before the first write.** It charges nothing and touches no expiry.
- **The script returns its own totals.** The caller builds \`X-RateLimit-Remaining\` and
  \`Retry-After\` from the reply. A follow-up \`GET\` could already include another request's charge.
- **The expiry is set by the write that creates the key**, inside the same script.
- **Validate before the first write.** An error raised by \`redis.call\` stops the script, but any
  writes it made before the error stay. Redis has no rollback.

Every course language has a helper that sends \`EVALSHA\` (the cached script, by its SHA1) and falls
back to \`EVAL\` when the server answers \`NOSCRIPT\` after a restart or a failover:

\`\`\`python
reserve = r.register_script(RESERVE_LUA)            # once, at startup
admitted, used, ttl = reserve(keys=[key], args=[cost, LIMIT, 86400])
\`\`\`

\`\`\`typescript
redis.defineCommand('reserve', {numberOfKeys: 1, lua: RESERVE_LUA});
const [admitted, used, ttl] = (await redis.reserve(key, cost, LIMIT, 86400)) as number[];
\`\`\`

\`\`\`go
var reserve = redis.NewScript(reserveLua)            // package level
res, err := reserve.Run(ctx, rdb, []string{key}, cost, limit, 86400).Int64Slice()
\`\`\`

\`\`\`cpp
std::vector<long long> reply;
redis.eval(kReserveLua, {key}, {std::to_string(cost), std::to_string(kLimit), "86400"},
           std::back_inserter(reply));
\`\`\`

redis++ and Jedis send the script text with \`eval\`. To save the bytes on a hot path, load it once
with \`script_load\` / \`scriptLoad\` and call \`evalsha\`, then reload it on \`NOSCRIPT\`.

The token bucket is the classic multi-step decision: refill by elapsed time, compare, spend. Read the
bucket in one call and spend in another, and two requests share the last token.

:::widget token-bucket {"rate": 2, "burst": 5}

:::quiz
Q: A cost meter's script adds a report with four \`HINCRBY\` calls and returns nothing; the handler then calls \`HGETALL\` to answer with the window's totals. What is wrong?
- [ ] Nothing: \`HGETALL\` reads the hash in one command, so its totals are consistent
- [x] Another report can land between the script and the \`HGETALL\`, so the answer includes a charge that is not this request's
- [ ] \`HINCRBY\` inside a script does not return the new value
> \`HGETALL\` is atomic on its own, so the four fields agree with each other. They describe the hash after *some* later write, though, not after this one. The script already holds the totals it wrote, and returning them is the only way to report this request's effect exactly.
:::

:::details Scripts, functions and cluster slots
\`EVAL\` scripts belong to the application: the server does not name, version or persist them, so a
client must be ready to send them again. Redis 7 added *functions* (\`FUNCTION LOAD\`, \`FCALL\`),
which the server stores and replicates like data. The atomicity is identical. In a cluster, a
script whose keys hash to different slots is refused with \`CROSSSLOT\`. Design the keys of one
decision to share a hash tag (\`{tenant}\`, \`{job}\`) from the start.
:::

# Fix 3: compare-and-set with a version

Sometimes the new value is computed outside Redis: a workflow step ran for a minute, a replicator
applied a batch, an operator edited a document. You cannot hold a script open for that long.
Instead, remember what you read, and write only if it is still what Redis holds:

\`\`\`lua
-- KEYS[1] run:{id}   ARGV[1] the version the caller read   ARGV[2] next step   ARGV[3] output ref
local v = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
if v ~= tonumber(ARGV[1]) then
  return {0, v}                                      -- somebody advanced it first
end
redis.call('HSET', KEYS[1], 'version', v + 1, 'step', ARGV[2], 'ref', ARGV[3])
return {1, v + 1}
\`\`\`

The forward-only variant compares the new value itself: an offset, a log sequence number or a
timestamp is applied only when it is greater than the stored one. **Compare numbers as numbers.**
Compared as strings, \`"9" > "10"\`, so a cursor stored as a string moves backwards at the first
digit rollover. Convert with \`tonumber\` inside the script.

What the caller does when the compare fails is part of the design, not an afterthought:

| The write is | On a failed compare |
| --- | --- |
| A merge that is still valid against the new value | Re-read and try again, a bounded number of times |
| A user's edit against a version they saw | Refuse it (409) and let them see the new version |
| An older event arriving late | Drop it and report it as ignored |

For a single string key, Redis 8.4 adds \`SET key new IFEQ old\`, which does the compare and the
write in one command without a script.

# Fix 4: MULTI with WATCH, and its retry loop

\`MULTI\` queues commands and \`EXEC\` runs them together, with no other client in between. On its
own, MULTI cannot decide anything, because the replies only arrive at \`EXEC\`. A \`GET\` inside
MULTI tells you the value once it is too late to act on it. \`WATCH\` adds the decision: \`EXEC\`
runs only if none of the watched keys changed since the \`WATCH\` (including by expiry), and
otherwise returns nil so the client can try again.

\`\`\`python
with r.pipeline() as pipe:
    for _ in range(5):                               # bounded: contention is not a loop forever
        try:
            pipe.watch(key)
            used = int(pipe.get(key) or 0)           # immediate, outside the transaction
            if used + cost > LIMIT:
                pipe.unwatch()
                return False
            pipe.multi()
            pipe.incrby(key, cost)
            pipe.expire(key, 86400, nx=True)
            pipe.execute()                           # raises WatchError if key changed
            return True
        except WatchError:
            continue
    raise Contended(key)
\`\`\`

\`\`\`go
err := rdb.Watch(ctx, func(tx *redis.Tx) error {
    used, err := tx.Get(ctx, key).Int64()
    if err != nil && err != redis.Nil { return err }
    if used+cost > limit { return errRefused }
    _, err = tx.TxPipelined(ctx, func(p redis.Pipeliner) error {
        p.IncrBy(ctx, key, cost)
        p.ExpireNX(ctx, key, 24*time.Hour)
        return nil
    })
    return err                                       // redis.TxFailedErr: retry, bounded
}, key)
\`\`\`

WATCH is optimistic locking: cheap when keys rarely collide, and a retry storm when they do, which is
exactly the hot key a budget or a last unit is. Every retry costs another set of round trips. Use it
when the computation must stay in the client. Prefer a script when it can move to the server. One
more trap: errors *inside* EXEC do not roll back the commands that succeeded.

:::quiz
Q: A handler wraps \`GET stock\`, a comparison and \`DECR stock\` in \`MULTI\`/\`EXEC\` without \`WATCH\`. Is the last unit safe?
- [ ] Yes: MULTI makes the three steps one transaction
- [x] No: the \`GET\` reply only arrives with \`EXEC\`, after the \`DECR\` already ran, so the comparison cannot stop it
- [ ] Yes, as long as the client checks the \`GET\` reply before calling \`EXEC\`
> Inside MULTI every command answers \`QUEUED\`. The client never sees the stock before the decrement is committed, so the "check" decides nothing. WATCH followed by a GET outside the transaction, or a script, makes the comparison happen before the write.
:::

# What does not work

- **A read before the write.** \`EXISTS\` then \`SET\`, \`GET\` then \`SET\`, \`HGET\` then \`HSET\`:
  this is the bug itself, however close together the two calls are.
- **A client-side lock.** A \`threading.Lock\`, a Go \`sync.Mutex\` or an async mutex serializes one
  process. The service runs several, and each has its own lock.
- **A Redis lock around the read and the write.** \`SET lock NX PX\`, then \`GET\`, compare, \`SET\`,
  \`DEL lock\` takes five round trips instead of one. It is only safe while the holder never pauses
  longer than the lock's lifetime, and a paused holder whose lock expired still writes. Locks that
  guard work done outside Redis need deadlines and fencing ([leases](/guides/leases)). A decision
  inside Redis needs a script.
- **Charge, then refund.** \`INCRBY\`, compare, \`DECRBY\` when over: in between, other requests see
  the overshoot and are refused for credit that was never spent. A crash before the refund keeps the
  charge.
- **A sleep, a retry or a lower timeout.** These make the window smaller, not zero. The race just
  shows up less often, usually in production.

:::details When the state lives in two stores
A script is atomic only over the keys of one Redis. A decision that must change Redis *and* a
database, or Redis and a Kafka topic, cannot be one step. Make one store the source of truth, and
make the other follow it with an idempotent effect: an outbox for events
([producing events](/guides/producing-events)), a claim keyed by the operation id
([idempotent requests](/guides/idempotent-requests)), or a reconciliation that rebuilds the copy.
:::

# Proving it

A single-threaded test cannot fail on a race, so the proof needs **two clients acting at once and
an assertion about the end state**. Before the fix it must fail, and after the fix it must pass.

A barrier releases the clients together, but a short critical section can still finish before the
other thread starts. To fail reliably, **widen the window on purpose**: wrap the client so every read
pauses before it returns. The starter's client-side \`GET\` then always lets the other request in.
The fixed code has no client-side read, so the pause changes nothing.

\`\`\`python
class SlowReads:
    """A Redis client whose GET-family replies arrive late, so check-then-act always interleaves."""
    def __init__(self, inner, pause=0.05):
        self.inner, self.pause = inner, pause
    def __getattr__(self, name):
        attr = getattr(self.inner, name)
        if name not in ("get", "hget", "exists", "hgetall"):
            return attr
        def slow(*args, **kwargs):
            reply = attr(*args, **kwargs)
            time.sleep(self.pause)
            return reply
        return slow

def test_two_racing_reservations_spend_the_budget_once(r):
    r.delete(KEY)
    slow = SlowReads(r)
    start = threading.Barrier(2)
    results = []
    def call():
        start.wait()
        results.append(reserve(slow, "acme", cost=60, limit=100))
    threads = [threading.Thread(target=call) for _ in range(2)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert sorted(results) == [False, True]          # exactly one admitted
    assert int(r.get(KEY)) == 60                     # charged once
    assert r.ttl(KEY) > 0                            # created with its lifetime
\`\`\`

Then add the assertions that pin down the rest of the decision:

- **Many clients, exact count.** 50 clients each costing 3 against a limit of 100 admit exactly 33
  and leave exactly 99. "At most the limit" is not enough: a fix that refuses too much also passes
  it.
- **A refusal writes nothing.** Record the value and the TTL before a refused call, and assert both
  are unchanged afterwards.
- **The reply is this request's effect.** Run two concurrent recordings and assert each reply's
  totals equal the state right after its own write, not after both.
- **A failed compare changes nothing.** Hand the compare-and-set a stale version and assert the
  stored version and fields did not move.

Watch the race test fail against the starter first. A concurrency test that has never failed has
not proven anything.

:::quiz
Q: The race test passes against the starter 9 runs out of 10 without the \`SlowReads\` wrapper. What should you conclude?
- [ ] The starter is mostly correct and the flaw is rare enough to accept
- [ ] The test is flaky and should be deleted
- [x] The window is real but narrow; widen it deterministically so the test fails on every run before the fix
> One failure in ten is the race showing itself. In production, at thousands of requests a second, one in ten becomes many a minute. A test that fails only sometimes cannot prove a fix. Inject the pause (or a barrier between the read and the write) so the starter fails every time and the fix passes every time.
:::

# What to take away

- **Every command is atomic. A decision spread over several commands is not.** A read, a
  comparison in the client and a dependent write let two clients both pass.
- **Use one command when one exists.** \`SET NX EX\`, \`INCRBY\`/\`HINCRBY\`, \`SADD\`, \`LPOP\`,
  and act on their reply.
- **Use one script when the decision has several steps.** \`KEYS\` and \`ARGV\`, a constant body
  run by \`EVALSHA\`, the refusal before the first write, the TTL inside, and the totals returned.
- **Use compare-and-set for values computed outside Redis.** A version or a forward-only number,
  compared as a number, and a deliberate answer to a failed compare.
- **Use WATCH only with a bounded retry loop.** Prefer a script on a hot key.
- **Prove it with a test that fails first.** Two clients at once, a deliberately widened window,
  and exact end-state assertions.
`;

export const sources: Source[] = [
  {
    title: 'Scripting with Lua',
    url: 'https://redis.io/docs/latest/develop/programmability/eval-intro/',
    kind: 'docs',
    venue: 'Redis docs',
    takes:
      'A script runs atomically with the server blocked for its whole runtime; key names go in KEYS and values in ARGV; EVALSHA runs the cached script and the volatile cache answers NOSCRIPT after a restart or failover.',
  },
  {
    title: 'Transactions',
    url: 'https://redis.io/docs/latest/develop/using-commands/transactions/',
    kind: 'docs',
    venue: 'Redis docs',
    takes:
      'The GET, increment, SET race between two clients, MULTI/EXEC with no rollback, WATCH as check-and-set with a repeat on a null EXEC, and the note that a script does the same more simply and faster.',
  },
  {
    title: 'SET',
    url: 'https://redis.io/docs/latest/commands/set/',
    kind: 'docs',
    venue: 'Redis docs',
    takes:
      'NX and EX in one command that claims a key with its lifetime, and the Redis 8.4 IFEQ condition that makes a single-key compare-and-set one command.',
  },
  {
    title: 'How to do distributed locking',
    url: 'https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html',
    by: 'Martin Kleppmann',
    date: '2016-02-08',
    kind: 'post',
    venue: "Martin Kleppmann's blog",
    takes:
      'A lock holder that pauses past its lease still writes, so a lock wrapped around a read-modify-write is not a substitute for making the decision itself atomic or fenced.',
  },
];
