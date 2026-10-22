/**
 * The learning guide for the Redis lease lock: the one mechanism the drill rests on — a key taken with
 * SET NX PX, an owner token, compare-and-write scripts — and the two things a lease cannot promise.
 * Rendered at `/redis-lease-lock/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A distributed lock in Redis is **one key whose existence means "taken"**. Whoever creates it holds
the lock; the key carries a lease, so a holder that dies still gives it back; and every later write
checks that the key still names the caller. Cron singletons, "one deploy at a time" guards, cache
stampede breakers and job schedulers all run on this surface. The drill implements it as the module
\`lease_lock\` over one key \`lock:{name}\`:

:::diagram
{
  "nodes": [
    {"id": "worker", "kind": "service", "label": "workers", "sub": "acquire · extend · release — owner = a uuid per attempt", "x": 25, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "lock:{name} = owner, PX lease, frees itself", "x": 70, "y": 50}
  ],
  "edges": [
    {"from": "worker", "to": "redis", "kind": "redis", "label": "SET NX PX · EVAL compare-and-DEL · EVAL compare-and-PEXPIRE"}
  ]
}
:::

| Function | Command | \`True\` when | \`False\` when |
| --- | --- | --- | --- |
| \`acquire(name, owner, ttl_ms)\` | \`SET lock:{name} owner NX PX ttl_ms\` | the key did not exist and was written | anyone holds it — this owner included; nothing changes |
| \`release(name, owner)\` | one Lua script: \`GET\`, compare, \`DEL\` | the key held \`owner\` and is now gone | any other value, or no key; nothing touched |
| \`extend(name, owner, ttl_ms)\` | one Lua script: \`GET\`, compare, \`PEXPIRE ttl_ms\` | the key held \`owner\`; the lease now ends \`ttl_ms\` from now | a non-owner, a lapsed lease, a lock nobody holds; nothing created |

- The **owner** is an opaque string the caller picks — a uuid per attempt. It is what tells "my lock"
  from "a lock with the same name that somebody else took after mine lapsed".
- The **lease** is a \`PX\` TTL in milliseconds. While it runs, other owners are refused; once it has
  elapsed, anyone acquires without anybody releasing.
- Everything the caller needs is in the boolean. A refused call does not raise and does not write.
- The lock is **not reentrant**: the same owner asking twice gets \`False\` the second time.

This is the single-instance lock from Redis's own
[distributed-locks page](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/), with
its three rules — take it in one command, tag it with a random value, release it with a script.

# One command takes the lock and bounds it

The naive lock is \`SETNX\` — set if not exists — and it works until a holder crashes: the key stays,
and the lock is stuck until a human deletes it. The obvious patch, \`SETNX\` then \`PEXPIRE\`, has a
gap between the two commands, and a process that dies inside the gap leaves a key with no lease — the
same stuck lock, now rarer and harder to reproduce. Since Redis 2.6.12 the
[\`SET\` command](https://redis.io/docs/latest/commands/set/) takes both conditions at once:

\`\`\`text
SET lock:job a-7f3 NX PX 30000
  NX  — only if the key does not exist         (take the lock)
  PX  — and expire it in 30000 ms              (bound the lease)
  →  OK   the key was written: True
  →  nil  somebody holds it:   False, nothing changed
\`\`\`

| Approach | Holder crashes after taking the lock | Two workers race for it |
| --- | --- | --- |
| \`SETNX\` | stuck forever | one wins — correct |
| \`SETNX\` then \`PEXPIRE\` | stuck forever if the crash lands between the two | one wins — correct |
| \`SET … NX PX\` | freed when the lease ends | one wins — correct |

The reply is the whole contract: \`OK\` means the write happened and the caller is the owner;
\`nil\` means it did not. No read before, no \`PEXPIRE\` after. The value written is the owner
token, not \`1\` or \`"locked"\` — the next two sections are about why.

First writer wins and the key is the record, the same shape an idempotency key gives an API:

:::widget idempotency {}

:::quiz
Q: A worker runs \`SETNX lock:job 1\` and then \`PEXPIRE lock:job 30000\`. The process is killed between the two. What state is the lock in?
- [ ] Free — the lease was never set, so Redis treats the key as expired
- [x] Taken with no lease — every \`acquire\` gets \`False\` until someone deletes the key by hand
- [ ] Taken for 30 s — Redis applies the default lease to keys written with \`SETNX\`
> A key without a TTL lives until it is deleted. The crash left exactly the key the lease was meant to guard against, and no worker will ever release it because none of them owns it. \`SET NX PX\` writes the key and the lease in one command, so there is no instant at which one exists without the other.
:::

# Why the lock needs an owner

A lease solves the crash; it creates a new problem. A holder that is slow — a long garbage-collection
pause, a stalled disk, a network partition — can outlive its lease without noticing. When it finally
finishes and releases, it is no longer the holder. If \`release\` is a plain \`DEL\`, it deletes
**whoever holds the lock now**:

:::sequence
{
  "participants": ["worker A", "worker B", "Redis"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "SET lock:job 1 NX PX 30000", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "OK — A holds the lock", "kind": "reply"},
    {"from": "worker A", "to": "worker A", "label": "paused 40 s; the lease ends at 30 s and the key expires", "kind": "sync"},
    {"from": "worker B", "to": "Redis", "label": "SET lock:job 1 NX PX 30000", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "OK — B holds the lock", "kind": "reply"},
    {"from": "worker A", "to": "Redis", "label": "DEL lock:job — \\"we only delete our own locks\\"", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "1 — B's lock is gone", "kind": "reply"},
    {"from": "worker A", "to": "Redis", "label": "SET lock:job 1 NX PX 30000 (next job)", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "OK — A and B both run the critical section", "kind": "reply"}
  ]
}
:::

The policy "we only delete our own locks" is true of the code and false of the system: A's \`DEL\`
was written to delete A's lock, and the key it found was B's. The fix is to make the key say whose
it is. Every \`acquire\` writes a fresh random **owner** token as the value, and every later write
becomes a **compare-and-write**: act only if the value still equals my token.

| Situation | Key's value | \`release(job, a-7f3)\` | Why |
| --- | --- | --- | --- |
| A holds the lock | \`a-7f3\` | \`True\`, key deleted | the value is A's token |
| A's lease lapsed, B took it | \`b-c12\` | \`False\`, key kept | B's lock, B's lease, untouched |
| A's lease lapsed, nobody took it | *(no key)* | \`False\`, nothing created | there is nothing of A's to free |
| B tries to release A's lock | \`a-7f3\` | \`False\` for B | the value is not B's token |

Two properties of the token matter. It is **unique per attempt**, not per worker, so a stale
\`release\` from a lapsed attempt cannot match the key a re-acquire wrote. And it is **unguessable**
— a uuid or random bytes — so no client frees a lock it did not take. The drill's task calls it a
fencing token for the lock itself: the key is the resource, the token fences writes to it. The
resource *behind* the lock is another matter — the last section.

:::quiz
Q: Why is the owner a fresh uuid per \`acquire\`, rather than the worker's hostname?
- [ ] Hostnames are too long to store in a Redis string
- [x] A worker that lapses and re-acquires must not be able to release its new lock with the release from its old attempt
- [ ] So that two workers on one host can share the lock
> The token names an attempt, not a machine. With a per-host value, the stale release from attempt one would match the key written by attempt two — the same worker, the same value — and delete a lock it still believes it is done with. A uuid per attempt makes the old release miss.
:::

# The compare must run on the server

Compare-and-delete written as two commands from the client — \`GET\`, compare in Python, \`DEL\` —
has the same hole as the plain \`DEL\`, moved one step to the right. Between the \`GET\` that
returned my token and the \`DEL\` that follows, the lease can lapse and another owner can land:

:::sequence
{
  "participants": ["worker A", "worker B", "Redis"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "GET lock:job", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "a-7f3 — still mine, 2 ms of lease left", "kind": "reply"},
    {"from": "worker A", "to": "worker A", "label": "compares in the client: equal, so DEL", "kind": "sync"},
    {"from": "Redis", "to": "Redis", "label": "lease ends; lock:job expires", "kind": "sync"},
    {"from": "worker B", "to": "Redis", "label": "SET lock:job b-c12 NX PX 30000", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "OK — B holds the lock", "kind": "reply"},
    {"from": "worker A", "to": "Redis", "label": "DEL lock:job", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "1 — B's lock is gone again", "kind": "reply"}
  ]
}
:::

The read and the write have to see the same world, and only the server can promise that. Redis runs
a [Lua script](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/) without
interleaving any other client's command: from the script's \`GET\` to its \`DEL\`, nothing happens
in between — no expiry handling, no \`SET\` from B. The whole of \`release\` is:

\`\`\`lua
-- EVAL script 1 lock:job a-7f3
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
\`\`\`

Run against the same timeline, the script either sees \`a-7f3\` and deletes before B's \`SET\` can
run, or sees \`b-c12\` — or nothing — and returns \`0\`. Either way B still holds the lock
afterwards. The reply is the \`DEL\` count, so \`1\` is \`True\` and \`0\` is \`False\`.

- The key goes in \`KEYS[1]\`, the owner in \`ARGV[1]\`: the convention that lets Redis Cluster route
  the script. Real clients call \`EVALSHA\` with the cached hash and fall back to \`EVAL\`.
- The same shape protects every write after the first: \`extend\` is the same script with
  \`PEXPIRE\` in place of \`DEL\`.

:::quiz
Q: \`release\` does \`GET\`, compares in the client, then \`DEL\` — and the comparison is correct. Why is it still wrong?
- [ ] \`GET\` can return a stale value from a replica
- [x] The lease can end and another owner can take the key between the \`GET\` and the \`DEL\`
- [ ] Two round trips cost twice the latency
> Correctness is not about the comparison but about what can happen between it and the write. Two commands are two moments; a script is one. Redis guarantees nothing else runs between a script's read and its write, so "the value was mine" is still true when the \`DEL\` executes.
:::

# Extending a lease

A lease has to be short enough that a dead holder frees the lock soon, and long enough that a live
holder finishes. Those pull against each other, and the resolution is to pick a short lease and
**extend** it while the work is alive: \`extend(name, owner, ttl_ms)\` runs the same compare, then
\`PEXPIRE\` to \`ttl_ms\` from now, in one script.

\`\`\`lua
-- EVAL script 1 lock:job a-7f3 30000
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
\`\`\`

| Caller | Key's value | Result | The TTL |
| --- | --- | --- | --- |
| the owner, lease still running | \`a-7f3\` | \`True\` | reset to \`ttl_ms\` from now |
| a non-owner | \`a-7f3\` | \`False\` | does not move |
| the owner, but the lease already ran out | *(no key)* | \`False\` | nothing created — the owner has lost the lock |
| anyone, lock never taken | *(no key)* | \`False\` | nothing created |

The third row is the one that matters: \`extend\` **cannot resurrect a lease**. Once the key is gone
the holder has lost its exclusivity, and \`PEXPIRE\` on a missing key returns \`0\` rather than
creating one. A holder that gets \`False\` from \`extend\` has learnt it is no longer the holder and
should stop. This is why \`extend\` goes through the compare and not through a second \`SET … PX\`
with \`XX\`: \`SET XX\` would overwrite another owner's value.

Real systems run \`extend\` from a **heartbeat** — a timer at a fraction of the lease, say every
10 s on a 30 s lease — so a long job keeps the lock without a long lease, and a crash frees it
within one lease. The drill leaves the timer out; the script it would call is the one above.

:::quiz
Q: Worker A's lease ran out while it was paused; nobody has taken the lock yet. A wakes and calls \`extend\`. What should happen?
- [ ] \`True\` — nobody else holds it, so A keeps going with a fresh lease
- [x] \`False\`, and no key is created — A's exclusivity ended with the lease and A must re-acquire
- [ ] \`True\` if A calls within a grace period after expiry
> Between the expiry and A's \`extend\`, any other worker could have acquired and released; A has no way to know whether the world moved while it was out. A lapsed lease is lost, and the only honest answer is to tell A so and let it \`acquire\` again — with a new token.
:::

# What a lease cannot guarantee

The owner token protects the **key**. It does not protect the **resource the lock guards**. A holder
that is paused past its lease does not know it; when it resumes it carries on writing to the
database, the file, the API it believed it owned, and the next holder is already writing too:

:::sequence
{
  "participants": ["worker A", "worker B", "Redis", "storage"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "acquire(job, a-7f3, 30000) → True", "kind": "sync"},
    {"from": "worker A", "to": "worker A", "label": "stop-the-world GC pause, 45 s", "kind": "sync"},
    {"from": "Redis", "to": "Redis", "label": "lease ends; lock:job expires", "kind": "sync"},
    {"from": "worker B", "to": "Redis", "label": "acquire(job, b-c12, 30000) → True", "kind": "sync"},
    {"from": "worker B", "to": "storage", "label": "write (B is the holder)", "kind": "sync"},
    {"from": "worker A", "to": "storage", "label": "write (A still believes it is the holder)", "kind": "sync"},
    {"from": "worker A", "to": "Redis", "label": "release(job, a-7f3) → False — too late, the write already landed", "kind": "sync"}
  ]
}
:::

Nothing in Redis can stop A's write: A does not talk to Redis before writing, and a check before the
write has the same gap after it. This is the heart of Martin Kleppmann's
[*How to do distributed locking*](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html):
a lease on its own is fine for **efficiency** (don't do the same expensive job twice) and not
sufficient for **correctness** (never let two writers touch the resource). For correctness the
resource has to take part:

- **Fencing token.** The lock hands out a strictly increasing number with every acquire — in Redis
  terms, \`INCR\` in the same script as the \`SET\`. The holder sends it with every write, and the
  **storage** rejects a write whose token is smaller than the largest it has seen: A's write carries
  \`33\`, B's \`34\`; the store has seen \`34\`, so \`33\` is refused. The owner uuid cannot do this
  job — it is random, not ordered, and the store never sees it.
- **The resource checks it.** A fencing token is only as good as the store that enforces it: a
  conditional write, a version precondition. A plain file system cannot.

The second gap is the clock. \`PX 30000\` is thirty seconds **by Redis's clock**; the holder's sense
of "I still have time" is by its own, measured from before the round trip. A pause, a slow network,
NTP stepping a clock forward — each lets a holder believe in lease it no longer has. The same drift
is why Redlock, Redis's algorithm for taking the lock on a majority of N independent instances, was
disputed: it survives one instance failing, but its safety still rests on every node's clock running
at roughly the right rate. Kleppmann argued a safety property should not depend on timing; antirez's
[reply](http://antirez.com/news/101) argued every lease already makes that assumption and that the
fencing token fixes the resource's side, not the lock's.

:::details Where the drill stops and real systems go on
The drill is the single-instance lock and nothing around it: no retry-with-backoff while waiting to
acquire, no heartbeat thread calling \`extend\`, no fencing counter, one Redis. The Redis page
recommends Redlock when a single master is not trustworthy enough — a crash with asynchronous
replication can lose the key and let a replica hand the lock out twice — and a consensus store
(ZooKeeper, etcd) is the usual choice when the lock's correctness is the product. All of them keep
the same three ideas: take-and-bound in one write, an owner value, server-side compare after.
:::

:::quiz
Q: A deploy lock guards a script that runs database migrations. Which statement is true?
- [ ] The owner token in \`lock:deploy\` guarantees two migrations never run at once
- [x] A holder paused past its lease can still run its migration; only a fencing token checked by the database closes that gap
- [ ] A short enough lease makes the gap impossible
> The token is compared when the holder talks to Redis — on release and extend — not when it talks to the database. A paused holder talks to the database first. No lease length removes a pause of unknown length; a monotonically increasing token that the database refuses when out of date does.
:::

# What to take away

- **Take and bound in one command.** \`SET lock:{name} owner NX PX ttl_ms\`: the key and its lease
  exist together or not at all, so a holder that dies still gives the lock back.
- **The value is an owner token, unique per attempt.** It turns "delete the lock" into "delete the
  lock if it is still mine", and makes a stale release from a lapsed attempt miss.
- **Compare on the server.** \`GET\` then \`DEL\` from the client has the same race as a plain
  \`DEL\`; a Lua script runs the read and the write with nothing in between.
- **Extend through the same compare.** \`PEXPIRE\` only while the key still names the caller; a
  lapsed lease is lost, never resurrected. A heartbeat keeps a short lease alive for long work.
- **A lease protects the key, not the resource.** For correctness the resource must check a fencing
  token; a lease alone is an efficiency tool, and its clock assumptions are the whole Redlock debate.

The primary reference is Redis's
[*Distributed Locks with Redis*](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/):
the single-instance lock in its first half is exactly the drill — one \`SET NX PX\`, a random value,
a release script — and its second half is Redlock and the safety argument around it.
`;
