/**
 * The learning guide for the cache-aside drill: the read path, the stampede and the fill lock, negative
 * caching, invalidation, and what a failing loader must leave behind — a figure or a demo where one says
 * it faster than prose, a pop quiz per section.
 * Rendered at `/redis-cache-aside/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

**Cache-aside** (lazy loading) is the cache pattern a read path ends up with when the cache is a
separate store and the application does the work: look in the cache first; on a miss, load from the
slow source, write what came back with a TTL, return it. Nothing fills the cache except a request that
needed the value. The drill implements it for a product catalogue:

:::diagram
{
  "nodes": [
    {"id": "app", "kind": "service", "label": "product service", "sub": "get_product(id, load) · invalidate(id)", "x": 20, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "product:{id} EX 3600 · lock:product:{id} EX 5", "x": 55, "y": 30},
    {"id": "source", "kind": "db", "label": "catalogue DB", "sub": "load(id) — slow, may return None, may raise", "x": 55, "y": 70}
  ],
  "edges": [
    {"from": "app", "to": "redis", "kind": "redis", "label": "GET · SET NX EX · SET EX · DEL"},
    {"from": "app", "to": "source", "kind": "plain", "label": "load(id) — only on a miss, only holding the lock"}
  ]
}
:::

The contract, in one line each:

- \`get_product(product_id, load)\` — \`GET product:{id}\`; JSON → decode and return; the sentinel
  \`__missing__\` → \`None\`; nothing → take \`lock:product:{id}\` with \`SET NX EX 5\`, re-read, \`load\`, write
  with a TTL, \`DEL\` the lock. Losers poll every \`POLL_S = 0.05\` s for at most \`LOCK_TTL_S = 5\` s.
- \`invalidate(product_id)\` — \`DEL product:{id}\`. The next call loads.
- Constants: \`TTL_S = 3600\` for a product, \`MISSING_TTL_S = 60\` for the sentinel, \`LOCK_TTL_S = 5\`,
  \`POLL_S = 0.05\`.
- The stored JSON is exactly what \`load\` returned; nothing is added or renamed.

# The read path: hit, sentinel, miss

Every call starts with one \`GET\`, and every other path ends by going through the same \`GET\` again.
Three things can come back:

| \`GET product:{id}\` returns | Meaning | Action |
| --- | --- | --- |
| JSON | hit | decode, return — no Redis write, no \`load\` |
| \`__missing__\` | hit on an absence | return \`None\` — no \`load\` |
| nil | miss (never loaded, expired, or invalidated) | take the lock, fill |

The happy path for a cold key, one caller:

\`\`\`text
GET product:42                         → (nil)
SET lock:product:42 1 NX EX 5          → OK          # won the election
GET product:42                         → (nil)       # nobody filled it meanwhile
load(42)                               → {"id": 42, …}
SET product:42 '{"id": 42, …}' EX 3600 → OK
DEL lock:product:42                    → 1
\`\`\`

- **The TTL is the only consistency guarantee the cache gives.** A product edited at 10:00 can be
  served as it was until 11:00 unless something deletes the key; that is why \`invalidate\` exists.
- **Write with the TTL in the same command.** \`SET key value EX 3600\` is one write; a \`SET\` followed by
  an \`EXPIRE\` leaves a window in which a crash makes the key immortal.
- **Nothing touches the source on a hit.** The cache is cheap precisely because the common case is
  one round trip to Redis and zero to the database.

:::widget cache-aside {}

:::quiz
Q: A product is edited in the database at 10:00 and nobody calls \`invalidate\`. What do readers see?
- [ ] The new product; the cache re-reads the source on every GET to check
- [x] The old product until \`product:{id}\` expires — up to an hour
- [ ] An error, because the cached JSON no longer matches the row
> Cache-aside never compares the cache to the source; a hit is served as is. The TTL bounds the staleness, and \`invalidate\` on the write path is what removes it early.
:::

# The stampede, and the fill lock

A hot key expires. Every request in flight for it misses at the same instant, every one of them calls
\`load\`, and the database — which was idle because the cache was doing its job — takes a hundred
identical queries at once. The literature calls it a
[cache stampede](https://en.wikipedia.org/wiki/Cache_stampede) or thundering herd; the naive read
path has no defence:

:::sequence
{
  "participants": ["req A", "req B", "req C", "Redis", "source"],
  "messages": [
    {"from": "req A", "to": "Redis", "label": "GET product:42", "kind": "sync"},
    {"from": "Redis", "to": "req A", "label": "(nil) — just expired", "kind": "reply"},
    {"from": "req B", "to": "Redis", "label": "GET product:42 → nil", "kind": "sync"},
    {"from": "req C", "to": "Redis", "label": "GET product:42 → nil", "kind": "sync"},
    {"from": "req A", "to": "source", "label": "load(42)", "kind": "sync"},
    {"from": "req B", "to": "source", "label": "load(42)", "kind": "sync"},
    {"from": "req C", "to": "source", "label": "load(42) — N misses, N loads", "kind": "sync"},
    {"from": "source", "to": "req A", "label": "{…} — slow, slower under N", "kind": "reply"},
    {"from": "req A", "to": "Redis", "label": "SET product:42 … EX 3600 (B and C overwrite it with the same value)", "kind": "sync"}
  ]
}
:::

The fix is an election: one atomic command decides who fills, and everyone else waits for the
winner's write rather than going to the source themselves.

:::sequence
{
  "participants": ["req A", "req B", "Redis", "source"],
  "messages": [
    {"from": "req A", "to": "Redis", "label": "GET product:42", "kind": "sync"},
    {"from": "Redis", "to": "req A", "label": "(nil)", "kind": "reply"},
    {"from": "req A", "to": "Redis", "label": "SET lock:product:42 1 NX EX 5", "kind": "sync"},
    {"from": "Redis", "to": "req A", "label": "OK — A fills", "kind": "reply"},
    {"from": "req B", "to": "Redis", "label": "GET product:42 → nil · SET lock NX → nil", "kind": "sync"},
    {"from": "Redis", "to": "req B", "label": "B lost: sleep 50 ms, GET again", "kind": "reply"},
    {"from": "req A", "to": "Redis", "label": "GET product:42 (still nil)", "kind": "sync"},
    {"from": "req A", "to": "source", "label": "load(42)", "kind": "sync"},
    {"from": "source", "to": "req A", "label": "{\\"id\\": 42, …} or None", "kind": "reply"},
    {"from": "req A", "to": "Redis", "label": "SET product:42 <json> EX 3600 (or __missing__ EX 60) · DEL lock", "kind": "sync"},
    {"from": "req B", "to": "Redis", "label": "GET product:42", "kind": "sync"},
    {"from": "Redis", "to": "req B", "label": "{\\"id\\": 42, …} — no load", "kind": "reply"}
  ]
}
:::

- **One command is the election.**
  [\`SET key 1 NX EX 5\`](https://redis.io/docs/latest/commands/set/) sets the key only if it does not
  exist *and* gives it a TTL, atomically. The reply — \`OK\` or nil — is the whole decision; no
  \`EXISTS\`-then-\`SET\`, no \`SETNX\`-then-\`EXPIRE\`.
- **The winner re-reads before loading.** "Miss, then lock" is two commands; between them another
  caller may have finished the entire fill and released. Without the second \`GET\`, the lock
  *serialises* the loads — one at a time, every one of them — instead of collapsing them into one.
- **Losers poll the key, not the lock.** \`sleep(0.05)\`, \`GET product:{id}\`, repeat; the first value
  they see is their answer. They never learn who won and never need to.
- **The wait is bounded by the lock's own TTL.** A loser gives up after \`LOCK_TTL_S\`; if nothing has
  appeared by then, the holder is gone and so is its lock — start over from the miss (next section).

The accounting: N concurrent misses cost one \`load\`, N lock attempts, and a few 50 ms sleeps each.
The database sees one query per key per hour.

:::widget cache-aside {"stampede": true}

:::quiz
Q: The winner takes the lock and calls \`load\` immediately, without a second \`GET\`. Two hundred requests miss within the same 300 ms load. How many loads does the source see?
- [ ] One — the lock guarantees it
- [x] Possibly many: each loser that wakes after the winner releases can win the next election and load again if it never re-reads
- [ ] Two hundred — the lock changes nothing
> The losers poll the key and will usually see the winner's value. But a caller that missed just before the winner's \`DEL\`, then wins the lock, must look at the key again: it was filled a moment ago. Skip the re-read and the lock turns a stampede into a queue of loads rather than one load.
:::

# Caching the absence

The cheapest denial of service against a cache-aside service is a request for something that does
not exist. \`load\` returns \`None\`; the naive fill writes nothing, because there is nothing to write;
the next request misses again and the database answers the same question forever. A scraper walking
ids, a deleted product still linked from somewhere, a typo in a URL — all go straight through.

**Negative caching** stores the answer "there is no such product" as a value with its own TTL:

| What \`load\` returned | Written | TTL | Why that long |
| --- | --- | --- | --- |
| a product | its JSON, unchanged | \`TTL_S\` = 3600 s | products change rarely; \`invalidate\` handles edits |
| \`None\` | the sentinel \`__missing__\` | \`MISSING_TTL_S\` = 60 s | a product created a minute from now must appear within a minute |

- The sentinel is a **value**, not an absence, because an absence is indistinguishable from a miss.
  The hit path tests for it before decoding JSON and returns \`None\` without calling \`load\`.
- The TTL is **short** because a negative answer goes stale in the other direction: a product that
  did not exist is the one most likely to exist soon (it is being created). A minute of "not found"
  after creation is acceptable; an hour is a support ticket.
- \`invalidate\` deletes the sentinel like any other value, so a writer that creates the product and
  calls \`invalidate\` makes it visible at once.
- Under the fill lock, a negative fill costs the source one query per id per **minute** — bounded,
  which is the point — rather than one per request.

:::quiz
Q: Why cache a missing product for 60 s rather than for the same hour as a real product?
- [ ] Redis charges more for short keys
- [x] A negative answer is the one most likely to become wrong soon — the product is probably about to be created — and an hour of 404 after creation is a defect
- [ ] Because the sentinel is not JSON and cannot carry a long TTL
> Both TTLs bound staleness, but in opposite directions. A real product that changes is a slightly stale page; a product that appears and stays "missing" is invisible. The cost of the shorter TTL is one source query per id per minute, which the lock already bounds.
:::

# Invalidate, do not update

When the product changes, the writer has two options: write the new value into the cache
(write-through, or "update on write") or delete the key and let the next reader fill it. The drill
takes the second — \`invalidate(id)\` is one \`DEL product:{id}\` — and the
[cache-aside pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)
recommends the same, for a concurrency reason rather than a laziness one:

:::sequence
{
  "participants": ["writer", "reader", "DB", "Redis"],
  "messages": [
    {"from": "reader", "to": "Redis", "label": "GET product:42 → nil", "kind": "sync"},
    {"from": "reader", "to": "DB", "label": "load(42) → price 10", "kind": "sync"},
    {"from": "writer", "to": "DB", "label": "UPDATE price = 12", "kind": "sync"},
    {"from": "writer", "to": "Redis", "label": "SET product:42 {price: 12}  (update-on-write)", "kind": "sync"},
    {"from": "reader", "to": "Redis", "label": "SET product:42 {price: 10} EX 3600 — stale for an hour", "kind": "sync"}
  ]
}
:::

With \`DEL\` instead of \`SET\` on the writer's side the same interleaving still leaves the stale
\`price: 10\` in the cache — the reader's write lands after the delete — but the window is the
duration of one \`load\`, not "any time a writer and a reader overlap", and the writer never has to
know how the reader serialises the value.

| | Update on write | Invalidate on write |
| --- | --- | --- |
| Writer must know | the cache's JSON shape, TTL, key | the key |
| Race with an in-flight fill | loses: the fill overwrites the new value for an hour | narrow: only a fill that read before the \`UPDATE\` and wrote after the \`DEL\` |
| Cost on write | one \`SET\` | one \`DEL\` |
| Cost on next read | none | one \`load\` |
| Keys nobody reads again | written anyway | never refilled |

- \`invalidate\` on an id that is not cached is harmless: \`DEL\` of a missing key returns 0.
- It deletes a sentinel exactly as it deletes a product — creation and deletion both go through it.
- The lock is not touched; a fill in flight finishes and writes what it loaded. Real systems close
  that last window with a second delete after a short delay, or by publishing invalidations from the
  database's change stream so every writer does not have to remember to call it.

:::details Why not write-through from the service that owns the data
Write-through keeps the cache warm and hides the miss after an edit, and it is the right call when the
same process does every write and knows the exact bytes the readers expect. Cache-aside separates the
two: the reader owns serialisation, the writer owns only the fact that the row changed. In a catalogue
with imports, admin tools and an API all writing products, "delete the key" is the one instruction
every writer can get right.
:::

:::quiz
Q: A product's price changes. The writer updates the row and then writes the new JSON into \`product:{id}\`. A reader that loaded the old row a moment earlier writes its JSON last. What is cached?
- [x] The old price, for up to an hour — the reader's fill overwrote the writer's update
- [ ] The new price; Redis orders writes by the time the row changed
- [ ] Both; Redis keeps every version
> Redis keeps the last write, and the last write here is the stale fill. A writer that deletes instead of sets has no value to lose the race with; the worst case shrinks to a fill that straddled the update.
:::

# What a failing loader leaves behind

The fill is the one place the code holds a resource — the lock — while doing something that can
fail. The database times out, the connection pool is empty, \`load\` raises. What must be true
afterwards?

| Outcome of \`load\` | Written to \`product:{id}\` | \`lock:product:{id}\` afterwards | Caller gets |
| --- | --- | --- | --- |
| a product | JSON, \`EX 3600\` | deleted | the product |
| \`None\` | \`__missing__\`, \`EX 60\` | deleted | \`None\` |
| raises | **nothing** — never cache an error as an absence | deleted, by the \`finally\` | the error, re-raised |
| the process dies mid-load | nothing | expires on its own after 5 s | — |

Two safety nets, one for each way of failing:

- **Release in a finally.** \`DEL lock\` runs whether or not \`load\` raised: with the lock released, the
  next caller takes it and retries at once, so a failing database is a slow minute rather than a
  stuck one. And the error is re-raised, not swallowed: the caller decides what a product page does
  without its product. Writing \`__missing__\` on an exception would turn a database blip into a
  minute of 404s for every id it touched.
- **A TTL on the lock.** \`EX 5\`, because a \`finally\` does not run when the process is killed. The TTL does what no
  code can: it releases the lock of a holder that no longer exists. The losers' bounded wait is sized
  by the same \`LOCK_TTL_S\`, because that is exactly how long a dead holder's lock can live. After the
  deadline, a loser starts over from the miss — \`GET\`, \`SET NX\`, and this time it wins.

\`\`\`python
if r.set(lock, 1, nx=True, ex=LOCK_TTL_S):      # won
    try:
        cached = r.get(key)                      # a loser may have just filled it
        if cached is None:
            product = load(product_id)
            if product is None:
                r.set(key, MISSING, ex=MISSING_TTL_S)
            else:
                r.set(key, json.dumps(product), ex=TTL_S)
    finally:
        r.delete(lock)                           # always — also when load raised
\`\`\`

The \`DEL\` in the drill is unconditional, which is the simple and slightly wrong version: a holder
that took longer than 5 s to load deletes a lock that now belongs to someone else. Real
[Redis locks](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/) store a random
token as the value and release with a Lua script that compares it first; the drill keeps the lock
TTL comfortably above any plausible \`load\` instead.

:::quiz
Q: \`load\` raises a timeout. What should the fill leave in Redis?
- [ ] \`__missing__\` for 60 s, so the failing database gets a minute of rest
- [x] Nothing under \`product:{id}\`, and no lock — the next caller retries immediately
- [ ] The lock, so nobody else hits the database until it expires
> An error is not an absence; caching it as one lies to every reader for a minute. Leaving the lock makes every reader wait five seconds for nothing. Release, re-raise, and let the next caller try — if the database is really down, each attempt fails fast and the lock still bounds the concurrency to one load at a time.
:::

# What to take away

- **Cache-aside is three cases on one read.** JSON → return; sentinel → \`None\`; nil → fill. Every
  path ends by going through the hit path again.
- **One atomic command is the stampede defence.** \`SET NX EX\`: the reply is the election, the TTL is the safety
  net, and the winner re-reads before loading — otherwise the lock serialises loads instead of
  collapsing them.
- **Cache the absence, briefly.** \`__missing__\` for 60 s turns a request-per-miss into a
  query-per-minute; a value, because an absence looks like a miss.
- **Invalidate, do not update.** \`DEL\` on write needs nothing from the writer but the key, and has no
  value to lose a race with.
- **A failing fill leaves nothing behind.** No cached error, no lock: \`finally: DEL\` for exceptions,
  \`EX 5\` for a dead holder, and a loser's wait sized by that same TTL.

The primary reference is the
[Cache-Aside pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside) in
the Azure Architecture Center — the pattern, its consistency caveats, and why the write path deletes
rather than updates; the [cache stampede](https://en.wikipedia.org/wiki/Cache_stampede) article covers
the failure the lock prevents and the alternatives production systems choose between.
`;
