import type {Source} from '@/lib/types';

/**
 * The keys-and-expiry guide: what a Redis key must name, when its lifetime is decided, which state
 * must never expire, and how to prove all three on a virtual clock. Rendered at `/guides/keys-and-expiry`.
 */
export const guide = `# The failure mode

A key-value store answers exactly the question it is asked. Ask it for \`budget:2026-11-12\` and it
returns whatever was last written under that name, whoever wrote it and whenever. It does not know
that the value was acme's, that it was computed by last month's model, or that the day it counted
ended an hour ago. Two things decide whether that answer is right, and both are fixed the moment the
key is written:

- **The name.** Every input the value depends on must be in the key. A part that is missing makes two
  different values share one name: the second writer overwrites the first, or the second reader gets
  the first one's answer. That is cross-talk, and it never raises an error.
- **The lifetime.** Every key is either volatile (it has a TTL) or persistent. Which one it is, and for
  how long, is a decision about correctness, not about memory: a counter that outlives its window
  refuses a tenant that did nothing wrong, and a cursor that expires replays a week of changes.

The smallest instance fits in four lines:

\`\`\`python
def allow(tenant: str) -> bool:
    count = r.incr(f"rate:{tenant}")       # no window in the name
    r.expire(f"rate:{tenant}", 60)         # a second command, after the first
    return count <= 100
\`\`\`

It passes every demo. Then three things go wrong, each without a stack trace. The key has no minute
in it, so each request pushes the expiry 60 seconds further out and a tenant that keeps a steady
trickle of traffic never gets a fresh window. A process killed between \`INCR\` and \`EXPIRE\` leaves a
counter with no TTL at all, which refuses that tenant for good once it reaches 100. And
\`rate:Acme\` and \`rate:acme\` are two budgets for one customer.

# How it shows up

The debugging courses plant this failure mode in the state step of most systems, and it rarely looks
like a key problem from the outside. It looks like one tenant seeing another's data, a number that
stops resetting, or a system that forgets something it promised to remember:

- [LLM Gateway, step 2](/ai-gateway/2-tenant-budget): a tenant's daily token budget never comes
  back, and the key it is kept under is shared with the tenant's own tomorrow.
- [Embedding Service, step 2](/embedding-service/2-state): after a model upgrade the cache keeps
  serving the previous model's vectors, and a crash at the wrong moment leaves an entry that never
  leaves.
- [Vector Search Service, step 2](/vector-search/2-state): globex runs the query acme ran a minute
  ago and receives acme's documents; a search for 3 results is answered from an entry written for 10.
- [Product Search, step 2](/product-search/2-state): \`Kettle\` and \` kettle \` fill two entries,
  while two filter sets with the same text share one.
- [Email Delivery, step 2](/email-delivery/2-state): an unsubscribe is forgotten after an hour, and
  every per-minute counter stays in Redis for good.
- [CDC Streamer, step 2](/cdc-streamer/2-state): a subscription that was quiet over a weekend
  resumes from nothing.
- [Session Store, step 2](/session-store/2-state): a session that is used often enough lives
  forever, and a rotation quietly resets how old it is.
- [Autocomplete, step 2](/autocomplete-service/2-state): a bot walking prefixes grows one tenant's
  cache until Redis starts evicting everyone's entries.

The same three questions find all of them. What does this value depend on, and is each of those in
the key? When does this key stop being true, and is that lifetime set in the write that creates it?
Is this state a copy that may disappear, or the only record of something that must not?

:::quiz
Q: A result cache is keyed \`search:{sha256(query)}\`. The value depends on the tenant, the active index version and \`k\`. Which symptom do you expect first?
- [ ] A \`KeyError\` when a second tenant searches
- [x] A tenant receives results computed for another tenant, or for a different \`k\`, with a normal 200
- [ ] Redis refuses the write because the key already exists
> A missing scope never fails loudly. The second caller's lookup is a perfectly valid hit on a perfectly valid key; it simply belongs to someone else. That is why the fix is a key-design rule, not an error handler.
:::

# The mechanism

## A key names its whole scope

Write down the function the cache stands in front of, with every argument, and the key is its
signature. A vector search's answer is \`f(tenant, index_version, query, k)\`, so the key carries all
four. An embedding is \`f(model_version, text)\`, and the tenant joins it if tenants may not share
vectors. A rate counter is \`f(tenant, window)\`. The parts that are commonly forgotten:

| Missing part | What two callers end up sharing | Typical symptom |
| --- | --- | --- |
| tenant | one tenant's data with another | a data leak with a 200 |
| version (model, index, catalog, taxonomy) | the old version's answers after a release | an upgrade that does not show |
| window (minute, hour, UTC day) | this window's count with the last one's | a limit that never resets |
| parameters (\`k\`, filters, page size, locale) | an answer computed for different inputs | wrong length, wrong filter |
| user or session | one person's state with another's | personal data on someone else's screen |

Versioned keys also make invalidation cheap: bump the version and every reader moves to a fresh key,
while the old entries age out under their TTL. No scan, no \`DEL\` storm, no window where half the
entries are new.

Long or untrusted parts go in as a digest (\`sha256\` of the query, of the prompt, of the content):
the key stays short, and the raw text never shows up in \`MONITOR\`, slow logs or a keyspace dump.

## Normalising key parts

A key is compared byte for byte. \`Ana@Example.com\`, \`ana@example.com\` and \` ana@example.com \` are
three keys, so a suppression written for one is not found under the others, and a rate limit can be
dodged by changing case. Normalise every part once, in one function, before any key is built:
trim, case-fold where the domain says case does not matter (an email domain, a search query; not an
API key), canonicalise numbers (\`k=010\` and \`k=10\`), and sort set-like inputs (filters) before
hashing them. The same function must build the key on the write path and on the read path, or a
normalised write is never found by a raw read.

## The TTL travels in the write

Redis clears a key's TTL whenever the key is replaced: a plain \`SET\` on an existing key discards its
expiry. Commands that change a value in place (\`INCR\`, \`HINCRBY\`, \`LPUSH\`, \`HSET\`) leave the TTL
untouched, and a key they create has none. So there are two safe shapes and one unsafe one:

| Shape | Safe? | Why |
| --- | --- | --- |
| \`SET key value EX 60\` (or \`NX EX\`, \`PX\`, \`EXAT\`) | yes | value and lifetime land in one command |
| \`INCR\` then \`EXPIRE\` inside one Lua script or \`MULTI\`/\`EXEC\` | yes | Redis runs both or neither |
| \`SET key value\`, then \`EXPIRE key 60\` from the client | no | a crash, timeout or deploy in between leaves a key with no TTL |

:::sequence
{
  "participants": ["worker", "Redis"],
  "messages": [
    {"from": "worker", "to": "Redis", "label": "INCR rate:acme:28900140 → 1", "kind": "sync"},
    {"from": "Redis", "to": "worker", "label": "1", "kind": "reply"},
    {"from": "worker", "to": "worker", "label": "SIGKILL: rolling deploy", "kind": "sync"},
    {"from": "Redis", "to": "Redis", "label": "TTL rate:acme:28900140 → -1 (no expiry, forever)", "kind": "sync"}
  ]
}
:::

The client library is no help here: a pipeline without \`MULTI\` is several commands sent together, not
one atomic step, and a connection that drops after the first reply loses the rest. In each stack the
fix is the same shape:

\`\`\`python
# redis-py: value and lifetime in one command; NX makes the first writer win
won = r.set(f"emb:{tenant}:{model}:{digest}", vector_json, nx=True, ex=86_400)
\`\`\`

\`\`\`typescript
// ioredis: a counter and its expiry in one script
const WINDOW = 'local n = redis.call("INCR", KEYS[1]) ' +
  'if n == 1 then redis.call("EXPIREAT", KEYS[1], ARGV[1]) end return n';
const n = await redis.eval(WINDOW, 1, 'rate:' + tenant + ':' + minute, String((minute + 1) * 60 + 5));
\`\`\`

\`\`\`go
// go-redis: SetArgs carries the condition and the expiry together
ok, err := rdb.SetArgs(ctx, "lock:"+jobID, owner, redis.SetArgs{Mode: "NX", TTL: 30 * time.Second}).Result()
\`\`\`

\`EXPIRE\` has its own conditions since Redis 7: \`NX\` sets an expiry only on a key that has none,
\`GT\` only lengthens it, \`LT\` only shortens it. They are useful inside a script; they do not make two
client round trips into one.

:::details Why \`if n == 1\` and not an \`EXPIRE\` on every call
Setting the expiry only when the counter is created pins it to the first write in the window. Calling
\`EXPIRE key 60\` on every increment moves the deadline 60 seconds past the latest request, which is a
sliding expiry: under steady traffic the key never dies. With \`EXPIREAT\` to the window's end the
difference disappears, since every call names the same instant, but the \`n == 1\` guard still saves a
write per request. Either way the guard must run in the same script as the \`INCR\`, or a crash between
them is back.
:::

## Fixed windows expire with their window

A fixed-window counter has the window in its name (\`rate:{tenant}:{floor(now / 60)}\`) and expires
when that window ends, plus a little grace so a slow request near the edge still finds it. Then
three things hold by construction: a new window starts at zero because it is a new key, an old
window's key is gone shortly after its last possible use, and a refusal can say when it ends
(\`Retry-After = window_end - now\`, or the key's \`TTL\`).

A key without the window in its name and with a fixed TTL behaves differently: its window starts at
whatever request created it, so two tenants' minutes are not the same minute, and \`Retry-After\` can
only be guessed. A daily budget keyed by tenant alone, with a 24-hour TTL from the first request at
17:00, resets at 17:00, not at midnight UTC like the invoice says.

## The cost of a sliding expiry

Refreshing the TTL on every touch (\`EXPIRE\` after each read or write) gives "expires N seconds after
the last use". That is the right lifetime for idle state, such as a chat buffer that should vanish a
day after the last message, or a session that ends after 15 minutes of silence. It is the wrong lifetime
for anything that should end on a schedule, because a steady user never lets it end:

- a **rate window** that slides never resets for a client that keeps calling;
- a **cache entry** that slides is never refreshed while it stays popular, so the most-read entries are
  the stalest;
- a **session** that slides has no maximum age unless one is stored beside it and checked on every
  use (\`created_at + 8h\`, carried across rotations), and the sliding TTL is then capped at that.

Sliding also costs a write per read: a hot cache key turns every \`GET\` into \`GET\` + \`EXPIRE\`, doubling
traffic on the busiest keys and making reads replicate.

:::quiz
Q: A per-tenant counter is written with \`INCR rate:{tenant}\` followed by \`EXPIRE rate:{tenant} 60\` on every request. A tenant sends one request every 10 seconds, all day. What does its counter do?
- [ ] Resets every 60 seconds, like a fixed window
- [ ] Expires after 60 seconds of the first request and starts again
- [x] Never expires, so it climbs all day until the tenant is refused
> Each \`EXPIRE\` moves the deadline to 60 seconds after the latest request, and the next one arrives 10 seconds later. The key never reaches its deadline. Put the window in the key and set the expiry once, when the key is created.
:::

## State that must never expire

A TTL is a promise that losing the value is harmless: the next reader recomputes it, refetches it, or
starts a fresh window. Some state has no source to recompute it from. Redis is the record, and a TTL
on it is a scheduled data loss:

| State | What a TTL breaks |
| --- | --- |
| a stream or CDC cursor, a replication offset | a quiet weekend expires it and the consumer replays from the start, or skips to the end |
| a suppression or block list | an unsubscribe or a ban is forgotten after the TTL, and mail is sent to someone who opted out |
| a ledger (refunds against a payment, spend against a budget) | an expired ledger lets the same money be refunded twice |
| a pointer to the live version, a hash chain head | a read finds nothing and either fails or falls back to a default |
| a dedupe index that guarantees uniqueness | a duplicate created after the TTL is accepted as new |

Persistent keys need two other things instead. **A bound on their number**: one key per subscription
and table, or one set of suppressed addresses, grows with real entities, not with traffic. And **an
explicit end**: the key is deleted when the thing it records ends (the subscription is dropped, the
payment's refund window closes, the run finishes), by the code that ends it. Also mind the eviction
policy: under \`allkeys-lru\` Redis may evict a persistent key when memory runs out. Keep durable state
on an instance with \`noeviction\`, or at least \`volatile-*\`, so only keys with a TTL are candidates.

:::details Mixed lifetimes inside one record
Many records mix both kinds. A booking's hold expires after the 900-second payment window while the
slot map it lives in must not; a secret's previous version expires after its overlap while the
active-version pointer must not; a checkpoint's upload session expires while the committed
checkpoint must outlive it. The usual design is two keys with two lifetimes, so that a TTL on the
short-lived part cannot take the long-lived part with it. One hash with one TTL forces a single
lifetime onto both.
:::

## Unbounded growth

A key family is bounded when the number of live keys has a ceiling you can state. Three things
remove the ceiling:

- **No TTL on derived data.** Every cache entry and every window counter written without an expiry
  stays until eviction. A counter per address per minute is 1,440 keys per address per day.
- **A key part the caller controls.** A cache keyed by prefix, query or URL lets one client create as
  many keys as it can send requests. A TTL does not save you here: a bot writing 1,000 new prefixes a
  second keeps 300,000 entries alive under a 300-second TTL.
- **Collections that only grow.** A list that is pushed but never trimmed, a sorted set that is added
  to but never pruned.

The fixes are a TTL on everything derived, a per-scope cap (keep a tenant's 100 most recently used
prefixes in a sorted set and evict the coldest when adding the 101st, in the same script), and
\`LTRIM\` or \`ZREMRANGEBYRANK\` in the same atomic step as the push. When none of that is enough,
\`maxmemory\` with an eviction policy is the backstop, but eviction does not respect tenants: one
tenant's growth evicts everyone's entries.

# The fix and its trade-offs

1. **Write the key from the value's signature.** List every input, put each one in the key, digest
   the long or sensitive ones, and build the key in one function used by both reads and writes.
2. **Normalise in that same function**, by the rules of each part's domain.
3. **Choose the lifetime per key family** and write it down next to the key format: fixed (window
   end, version lifetime), sliding with a hard cap (idle state), or none (records, with a stated
   bound and an explicit delete).
4. **Set the lifetime in the write that creates the key**: \`SET ... EX\`, \`SET ... NX EX\`, or the
   \`EXPIRE\` inside the same Lua script as the \`INCR\`, \`HINCRBY\` or \`RPUSH\`.
5. **Cap every family the caller can grow**, in the same atomic step as the write.

The trade-offs are real, and choosing them is part of the fix:

| Choice | Buys | Costs |
| --- | --- | --- |
| more parts in the key | no cross-talk | lower hit rate, more keys; a part that does not change the value only fragments the cache |
| version in the key | instant, race-free invalidation | old versions linger until their TTL; one extra read to resolve the version |
| fixed window | simple, a clear \`Retry-After\` | a client can spend two windows' worth across a boundary; a sliding log or a token bucket fixes that at more cost |
| short TTL | bounded staleness and memory | more misses, more load on the source |
| grace after the window | a slow request still counts in its window | keys live a little longer than strictly needed |
| no TTL | durable records | a growth bound and an explicit delete are now your job |

:::widget token-bucket {}

When a fixed window's boundary burst matters, a token bucket is the usual next step: one key per
client holding tokens and a last-refill time, refilled and spent in one script, and expired once the
bucket would be full again, since an idle client's full bucket carries no information.

:::quiz
Q: A cache key is \`cache:{tenant}:{catalog_version}:{prefix}\`. A catalog publish bumps the version. What happens to the old entries?
- [ ] They are served until someone deletes them
- [x] Readers stop asking for them at once; they stay in memory until their TTL ends, so the TTL still matters
- [ ] Redis deletes them when the version changes
> Version-in-key invalidation moves readers, not data. The old keys are unreachable but still occupy memory, which is why a versioned key still needs a TTL: without one, every publish leaves a full copy of the cache behind for good.
:::

# Proving it on a virtual clock

Expiry bugs live in time, and a test that sleeps for a minute is a test nobody runs. Give the code a
clock it reads instead of \`time.time()\`, run it against an in-memory store that expires keys by that
same clock, as the courses' fake Redis does, and assert outcomes, not commands. A test that checks
"\`EXPIRE\` was called" passes for the
crash-prone two-command version; a test that checks "no key is left without a TTL after a crash" does
not. The first three tests below fail on the four-line \`allow\` from the top of this guide; in the last
two, \`put\`, \`get\`, \`confirm\` and \`load_cursor\` stand for a cache and a cursor with the same flaws.

\`\`\`python
def test_window_resets_on_the_minute(clock, r):
    clock.set(1_700_000_080)                 # 40 s into a minute
    for _ in range(100):
        assert allow("acme")
    assert not allow("acme")                 # the 101st in this minute is refused
    clock.advance(20)                        # the next minute starts
    assert allow("acme")                     # a fresh window, not a slid one

def test_a_steady_client_still_gets_new_windows(clock, r):
    clock.set(1_700_000_000)
    for _ in range(600):                     # one call every 10 s for 100 minutes
        assert allow("acme")
        clock.advance(10)

def test_no_key_survives_without_a_ttl(clock, r, crash_after_first_command):
    with crash_after_first_command:
        allow("acme")
    assert all(r.ttl(k) != -1 for k in r.scan_iter("rate:*"))

def test_tenants_and_spellings(clock, r):
    put("Acme", "kettle", ["kettle"])
    assert get("acme", " Kettle ") == ["kettle"]      # one tenant, one normalised entry
    assert get("globex", "kettle") is None            # never another tenant's

def test_the_cursor_outlives_a_quiet_weekend(clock, r):
    confirm("sub-1", "orders", lsn=42)
    clock.advance(3 * 86_400)
    assert load_cursor("sub-1", "orders") == 42
\`\`\`

The checks that matter, by key family:

- **Scope:** two callers that differ in one key part never see each other's value; two spellings of
  one input share one entry.
- **Window:** the count resets at the boundary (advance the clock past it), not N seconds after the
  last request; a steady client is never refused; the refusal's \`Retry-After\` equals the time left
  in the window.
- **Write-time TTL:** inject a failure after the first command and assert no key is left with
  \`TTL = -1\`; after a normal write, the TTL is the one the design says.
- **Durability:** advance the clock by days and assert the cursor, the suppression, the ledger and the
  pointer are still there.
- **Growth:** drive a thousand distinct caller-chosen parts and assert the key count stays at the cap.

:::details Why a virtual clock and not \`DEBUG SLEEP\` or a short TTL in tests
Shrinking every TTL to one second for the tests changes the code under test and still makes the
suite slow and flaky at the boundary. A virtual clock keeps the production TTLs, makes the boundary
exact (advance to \`window_end - 1\`, then to \`window_end\`), and lets a test cover three days of
idleness in a microsecond. It also forces the design to compute windows from one clock reading per
request, which removes a second class of bug: two \`time()\` calls that straddle a boundary and put
one request in two windows.
:::

:::quiz
Q: Which test catches a TTL set by a separate \`EXPIRE\` after the \`SET\`?
- [ ] Assert that \`EXPIRE\` was called with 60
- [ ] Write a key and assert \`TTL\` is 60
- [x] Fail the connection after the first command, then assert no key under the prefix has \`TTL = -1\`
> The first two pass for both versions, because on the happy path the separate \`EXPIRE\` runs. Only an injected failure between the two round trips separates the code that sets the lifetime in the write from the code that hopes the second command arrives.
:::

:::quiz
Q: An email service keeps \`mail:suppressed:{address}\` with a one-hour TTL "so the keyspace stays small". What is wrong?
- [ ] Nothing, as long as the TTL is longer than a send
- [x] Suppression is the only record of an opt-out; a TTL turns it into a scheduled resubscribe, and the address is not normalised either
- [ ] It should use a sliding TTL so active addresses stay suppressed
> A suppression list is a record, not a cache: there is no source to rebuild it from. It needs no TTL, a bound that comes from real addresses rather than traffic, and one normalised spelling per address so \`Ana@Example.com\` finds \`ana@example.com\`.
:::
`;

export const sources: Source[] = [
  {
    title: 'EXPIRE',
    url: 'https://redis.io/docs/latest/commands/expire/',
    kind: 'docs',
    venue: 'Redis documentation',
    takes:
      'A key replaced by SET or DEL loses its TTL while INCR, LPUSH and HSET leave it untouched, the NX, XX, GT and LT conditions, and the navigation-session pattern of a sliding expiry refreshed on every push.',
  },
  {
    title: 'SET',
    url: 'https://redis.io/docs/latest/commands/set/',
    kind: 'docs',
    venue: 'Redis documentation',
    takes:
      'SET discards any previous TTL, and its NX, EX, PX, EXAT and KEEPTTL options put the condition and the lifetime in the same command as the value.',
  },
  {
    title: 'INCR: Pattern: rate limiter',
    url: 'https://redis.io/docs/latest/commands/incr/',
    kind: 'docs',
    venue: 'Redis documentation',
    takes:
      'A per-second key with the window in its name, and the race in which a client that runs INCR but not EXPIRE leaks the key, fixed by moving both into one Lua script.',
  },
  {
    title: 'Key eviction',
    url: 'https://redis.io/docs/latest/develop/reference/eviction/',
    kind: 'docs',
    venue: 'Redis documentation',
    takes:
      'maxmemory and the eviction policies: allkeys-* may evict any key, volatile-* only keys with a TTL, and noeviction refuses writes, which is why durable state and caches belong on differently configured instances.',
  },
];
