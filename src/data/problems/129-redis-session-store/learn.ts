/**
 * The learning guide for the sliding-TTL session store: where server-side sessions come from, why a
 * session is one hash born with its EXPIRE, what sliding expiry buys over an absolute one, and why
 * the id and the DEL are the security of the whole thing. Rendered at `/redis-session-store/learn`.
 */
export const learn = `# The mechanism at a glance

A browser logs in once and carries a cookie from then on. Every later request has to become "which
user, and what have we remembered about them" without a trip to the user database — and when the
user walks away, that memory has to die on its own. A **server-side session** in Redis does both with
two commands used in the right order:

:::diagram
{
  "nodes": [
    {"id": "browser", "kind": "client", "label": "Browser", "sub": "cookie sid=… · 32 hex chars", "x": 10, "y": 50},
    {"id": "app", "kind": "service", "label": "app server", "sub": "create · get · touch · destroy", "x": 45, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "sess:{sid} · EXPIRE 1800 · evicts on its own", "x": 85, "y": 50}
  ],
  "edges": [
    {"from": "browser", "to": "app", "kind": "http", "label": "request + cookie"},
    {"from": "app", "to": "redis", "kind": "redis", "label": "HSET+EXPIRE · HGETALL+EXPIRE · DEL"}
  ]
}
:::

The contract the drill implements, with \`SESSION_TTL_S = 1800\`:

| Call | Redis | Answer |
| --- | --- | --- |
| \`create(user_id, data)\` | \`MULTI · HSET sess:{sid} user_id … created_at … <data> · EXPIRE sess:{sid} 1800 · EXEC\` | the new \`sid\`, 16 random bytes as 32 hex chars |
| \`get(sid)\` | \`HGETALL sess:{sid}\`; if non-empty, \`EXPIRE sess:{sid} 1800\` | the fields as a map, or \`None\`/\`null\` |
| \`touch(sid)\` | \`EXPIRE sess:{sid} 1800\` | \`True\` if the key existed (reply 1), \`False\` otherwise |
| \`destroy(sid)\` | \`DEL sess:{sid}\` | nothing; an unknown id is not an error |

- The hash is the session: \`user_id\`, \`created_at\` (unix seconds) and every entry of \`data\` as string
  fields. \`user_id\` and \`created_at\` are reserved names.
- The TTL is **idle time, not age**: every successful read or touch sets it back to 1800 s.
- Nothing else manages lifetime — no sweeper, no \`PERSIST\`, no \`last_seen\` comparison in code.
  Redis evicts what nobody reads for 1800 s, and \`get\` on it answers \`None\`.
- A miss writes nothing: neither \`HGETALL\` nor \`EXPIRE\` creates a key, so an id that was never
  issued never gains one.

Rails, Django, Express's \`connect-redis\` and most API gateways with a login page keep sessions in
exactly this shape.

# Server-side sessions versus signed cookies

Two designs answer "who is this request from". The cookie carries either a **reference** to state
held on the server, or the **state itself**, signed so the browser cannot forge it:

| | Server-side session (this drill) | Signed / encrypted cookie, JWT |
| --- | --- | --- |
| Cookie holds | a random id; nothing readable | the claims — user id, roles, expiry — plus a signature |
| Per-request cost | one \`HGETALL\` (plus the slide) | a signature check; no I/O |
| Size | one cookie of 32 chars | grows with the claims; every request carries it |
| Revoke one session | \`DEL\` and it is gone on the next request | impossible until it expires, unless you keep a server-side deny list — which is a session store again |
| Change what is remembered | \`HSET\` another field | reissue the cookie |
| Idle timeout | \`EXPIRE\` slid on read | needs a new signed cookie on every request, or none at all |
| Fails when | Redis is down: nobody can be identified | the signing key leaks: everybody can be forged |

The signed cookie wins when the server must be stateless across many unrelated services and a
revocation delay is acceptable. The server-side session wins whenever **log-out must mean something
now**, when the session holds more than a few bytes, or when the lifetime should follow activity.
OWASP's
[session-management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
treats the server-side session as the default and the cookie as nothing more than an opaque handle.

Both designs still need the cookie flags the drill leaves out:
[\`Set-Cookie\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie) with \`HttpOnly\`,
\`Secure\` and a \`SameSite\` value, so a script cannot read the id and a plain-HTTP request cannot leak it.

:::quiz
Q: A user reports their laptop stolen and asks support to log it out. Which design can do that at once?
- [x] The server-side session: \`DEL sess:{sid}\` and the next request from that laptop is a 401
- [ ] The signed cookie: re-sign it with a shorter expiry
- [ ] Neither; the user must change their password and wait
> The signed cookie's validity lives in the cookie, which is on the stolen laptop; the server has nothing to delete. The session store holds the only copy of "this id is logged in", so removing it is the revocation.
:::

# A hash per session, born with its TTL

Each session is one Redis **hash**: fields and values under one key, read in one round trip with
\`HGETALL\`, extended with \`HSET\` field by field, and — the point of using a key per session rather
than a field per session in one big hash — **expirable as a unit**. Redis attaches a timeout to a
key, not to a field, so one session per key is what lets Redis do the forgetting.

\`\`\`text
MULTI
HSET   sess:3f9a…c21e  user_id 42  created_at 1718000000  theme dark  cart 3
EXPIRE sess:3f9a…c21e  1800
EXEC
\`\`\`

Why the \`MULTI\`? Without it the write and the timeout are two commands, and a process can die between
them:

:::sequence
{
  "participants": ["app server", "Redis"],
  "messages": [
    {"from": "app server", "to": "Redis", "label": "HSET sess:{sid} user_id 42 … (no MULTI)", "kind": "sync"},
    {"from": "Redis", "to": "app server", "label": "OK — key exists, TTL -1", "kind": "reply"},
    {"from": "app server", "to": "app server", "label": "crash / deploy / OOM-kill before EXPIRE", "kind": "sync"},
    {"from": "app server", "to": "Redis", "label": "(EXPIRE never sent)", "kind": "async"},
    {"from": "Redis", "to": "Redis", "label": "sess:{sid} lives forever: a session no idle window ends and no sweeper finds", "kind": "sync"}
  ]
}
:::

A key with \`TTL -1\` is an **immortal session**: a credential that stays valid for as long as Redis
runs, invisible to every rule the rest of the system assumes. Inside
[\`MULTI\`/\`EXEC\`](https://redis.io/docs/latest/develop/interact/transactions/) the two commands are
queued and run back to back with nothing in between; the hash and its lifetime land together or not
at all. The same reasoning is why a miss must **write nothing**: an \`HSET\` to "refresh" a session that
does not exist would create one.

Two facts about [volatile keys](https://redis.io/docs/latest/commands/expire/) make the hash the
right container:

- **Writes that modify the value keep the timeout.** \`HSET\` on an existing session changes a field and
  leaves the TTL where it was; only commands that delete or overwrite the whole key (\`DEL\`, \`SET\`,
  \`RENAME\`, the \`*STORE\` family) clear it. Adding \`cart 4\` later does not need another \`EXPIRE\`.
- **Expiry is per key and exact to the millisecond** (since Redis 2.6 for the timeout, 6.0 for the
  clock). A key is reported absent the moment its deadline passes, whether or not Redis has physically
  freed it yet.

:::quiz
Q: \`create\` writes the hash, then sets the TTL in a second round trip. What is the failure this leaves open?
- [ ] Two requests racing create two sessions for one user
- [x] A crash between the two leaves a session that never expires
- [ ] The second command overwrites the fields
> HSET and EXPIRE are independent commands; if the process dies after the first, the key exists with no timeout. One MULTI makes "the key exists" and "the key has a TTL" the same event.
:::

# Sliding expiry versus absolute expiry

Set once, \`EXPIRE\` is an **absolute** lifetime: the key dies 1800 s after login, whatever the user is
doing. Reset on every read, it becomes an **idle** window — the session dies 1800 s after the last
request, which is what "you stay logged in while you keep using it" means:

:::sequence
{
  "participants": ["browser", "app server", "Redis"],
  "messages": [
    {"from": "browser", "to": "app server", "label": "POST /login", "kind": "sync"},
    {"from": "app server", "to": "Redis", "label": "MULTI · HSET sess:{sid} user_id … · EXPIRE sess:{sid} 1800 · EXEC", "kind": "sync"},
    {"from": "app server", "to": "browser", "label": "Set-Cookie: sid=… (32 hex)", "kind": "reply"},
    {"from": "browser", "to": "app server", "label": "GET /me (1000 s later)", "kind": "sync"},
    {"from": "app server", "to": "Redis", "label": "HGETALL sess:{sid}", "kind": "sync"},
    {"from": "Redis", "to": "app server", "label": "{user_id, created_at, …}  TTL 800", "kind": "reply"},
    {"from": "app server", "to": "Redis", "label": "EXPIRE sess:{sid} 1800 — slid", "kind": "sync"},
    {"from": "app server", "to": "browser", "label": "200", "kind": "reply"},
    {"from": "browser", "to": "app server", "label": "GET /me (1801 s idle)", "kind": "sync"},
    {"from": "app server", "to": "Redis", "label": "HGETALL sess:{sid}", "kind": "sync"},
    {"from": "Redis", "to": "app server", "label": "{} — evicted", "kind": "reply"},
    {"from": "app server", "to": "browser", "label": "401", "kind": "reply"}
  ]
}
:::

The same user, under the two policies, with a 1800 s window:

| Event | Absolute (EXPIRE once) | Sliding (EXPIRE on every read) |
| --- | --- | --- |
| login at t = 0 | TTL 1800 | TTL 1800 |
| request at t = 1000 | TTL 800, nothing changes | TTL back to 1800 |
| request at t = 1799 | TTL 1, answered | TTL back to 1800 |
| request at t = 1801 | gone — logged out mid-click | gone only if nothing happened since t = 1 |
| user active every 10 min for a day | logged out every 30 minutes | never logged out |
| tab abandoned at t = 1000 | gone at 1800 | gone at 2800 |

- The read is \`HGETALL\` **then** \`EXPIRE\`, and only when the map came back non-empty. Redis answers
  \`{}\` for a missing hash — never an error — and the empty map is the signal to return \`None\`
  without touching the key.
- A read at 1000 s buys **exactly** another 1800 s, not 1800 + 800: \`EXPIRE\` replaces the timeout, it
  does not add to it.
- \`touch\` is the slide without the read: \`EXPIRE\` alone, and its 0/1 reply is "does this session
  exist". A health-check or a websocket heartbeat can keep a session alive without pulling its fields.
- The fields are never rewritten by a read. Only the timeout moves.

Sliding alone has a weakness: a session that is used forever lives forever, and a stolen id that the
thief keeps exercising never expires. The OWASP guidance pairs the idle timeout with an **absolute**
one — hours for the idle window, a day or a week for the ceiling. Real systems add it as a second
check on the same hash: compare \`created_at\` at read time and refuse to slide past the ceiling, or
cap the \`EXPIRE\` argument at \`min(1800, absolute_deadline − now)\`. The drill stores \`created_at\`
and leaves the comparison out.

:::details How Redis actually evicts an expired key
Redis never scans every key on a timer. A key past its deadline is deleted **passively** when a
client touches it — which is why \`HGETALL\` on an expired session answers \`{}\` and not stale fields —
and **actively** by a background task that, ten times a second, samples a few volatile keys and
deletes the expired ones, repeating while more than a quarter of the sample was dead. Memory for
abandoned sessions is reclaimed within seconds of expiry, and nobody runs a sweeper.
:::

:::quiz
Q: A user is mid-checkout, 29 minutes after logging in, and clicks "pay". Which policy logs them out?
- [x] Absolute expiry: the session is 1800 s old regardless of their clicks
- [ ] Sliding expiry: every click reset the window, so they are still in
- [ ] Both: the TTL is the same number
> Under an absolute lifetime the deadline was fixed at login. Under a sliding one each of their earlier requests slid it back to 1800 s, so the session dies only after 30 minutes of nothing — which an active user never produces.
:::

# The id is the credential

Everything after login rests on one fact: the only way to become user 42 is to present the cookie
\`sid=3f9a…c21e\`. The id is not a lookup key that happens to be secret; it **is** the password for the
rest of the session. That sets its requirements:

- **Unguessable.** 16 bytes from a cryptographic source — \`secrets.token_hex(16)\`, \`randomBytes(16)\`,
  \`crypto/rand\`, \`SecureRandom\` — give 128 bits of entropy, 32 lower-case hex chars. OWASP's floor
  is 64 bits; 128 is what the frameworks ship.
- **Unrelated to anything.** No user id, no timestamp, no counter inside it. A sequential or
  time-based id lets anyone who has seen one guess its neighbours and walk through every live session.
- **Opaque.** The browser learns nothing from it, so there is nothing to tamper with; a cookie it
  invents is a miss, not a half-match.

| Source | Looks like | Why it fails |
| --- | --- | --- |
| counter, \`user_id + ts\` | \`42-1718000000\` | enumerable in one loop |
| \`uuid4\` trimmed to 32 hex | random-looking | 122 bits at best, and a library's UUID may not be from a CSPRNG |
| \`random()\` / \`Math.random()\` | random-looking | seedable PRNG; the stream is predictable from a few outputs |
| 16 bytes from the OS CSPRNG | \`3f9a…c21e\` | — |

How much is 128 bits? At a million guesses a second against a million live sessions, the expected
time to hit one is about \`2^128 / 10^12\` seconds — some \`10^19\` years. The guess rate is the
attacker's only lever, and the id's length makes it irrelevant.

The drill sends \`sid\` in the cookie as is. Production adds an HMAC over it, checked before Redis is
asked, so a fabricated id is rejected at the edge; and it issues a fresh id when an anonymous session
logs in, against [session fixation](https://owasp.org/www-community/attacks/Session_fixation) — an
attacker planting an id they know and waiting for the victim to authenticate under it.

:::quiz
Q: A teammate proposes \`sid = sha256(user_id + login_time)\` so sessions are "deterministic and debuggable". What is wrong?
- [ ] Hashes are slower than random bytes
- [x] Anyone who can guess a user id and an approximate login time can compute the credential
- [ ] SHA-256 output is too long for a cookie
> A hash of guessable inputs is a guessable value; the hash adds no secret. The id must be drawn from a cryptographic random source so that knowing everything about the user still tells you nothing about the cookie.
:::

# Destroy and expiry are the only log-out

A server-side session has exactly two ends, and both are a key disappearing:

\`\`\`text
destroy(sid)   →  DEL sess:{sid}              the user chose to end it
1800 s idle    →  Redis deletes sess:{sid}    nobody chose anything
\`\`\`

- **Log-out is a delete, not a flag.** A \`logged_out: true\` field would still be a hash that \`HGETALL\`
  returns and code has to remember to check. Deleting the key makes every future presentation of
  that id a miss by construction — in every code path, including the one someone writes next year.
- **Idempotent.** \`DEL\` on a missing key returns 0 and nothing else; a second log-out, or a log-out
  racing with expiry, is harmless. Other sessions are untouched.
- **Expiry is a security boundary, not housekeeping.** The idle window bounds how long a cookie left
  in an unlocked browser, a shared machine or a proxy log remains a valid credential. That is why
  nothing may extend a session except a real request from its holder — the reason the drill forbids
  \`PERSIST\` and any out-of-band sweeper logic.
- **Clearing the cookie is not log-out.** The browser forgetting the id does not invalidate it; anyone
  who copied it still has 1800 s. Log-out must delete the server's copy.

What one key per session cannot do by itself is "log me out everywhere": there is no index from a
user to their ids. Real systems keep one — a set \`user:{id}:sessions\` written at \`create\`, so a
password change or a stolen-device report becomes \`SMEMBERS\` and a few \`DEL\`s — and they delete the
session on any privilege change, so a demoted admin does not stay an admin until their window ends.

:::quiz
Q: Why must \`get\` on an unknown or expired id create no key, even an empty one?
- [ ] An empty hash would waste memory
- [x] Any key created by an unauthenticated request is a session the server never issued — a foothold an attacker can grow
- [ ] Redis refuses to EXPIRE an empty hash
> The store's security rests on "a key under sess:{sid} exists only because create made it". HGETALL and EXPIRE both leave a missing key missing; a refresh that used HSET would quietly break that invariant.
:::

# What to take away

- **A session is a key, and the key is the credential.** 128 random bits from a cryptographic source,
  opaque to the browser; a cookie holds the id, Redis holds the truth.
- **Born with its TTL.** \`HSET\` and \`EXPIRE\` in one \`MULTI\`, so no crash can leave an immortal session;
  a miss writes nothing, so no request can create one.
- **The TTL is idle time.** \`HGETALL\` then \`EXPIRE\` on every hit, \`touch\` is the \`EXPIRE\` alone; an
  active user never expires, an abandoned one is gone 1800 s after the last request, and Redis does
  the deleting.
- **Log-out is a delete.** \`DEL sess:{sid}\`: not a flag, not clearing the cookie; delete the server's copy and every later
  presentation of the id is a miss.
- **Real systems add** an absolute ceiling next to the idle window, a rotated id at login, a per-user
  set for "log out everywhere", a signed cookie with \`HttpOnly\`/\`Secure\`/\`SameSite\` — each one more
  key or one more check on the same hash.

The primary reference is the Redis
[\`EXPIRE\` command page](https://redis.io/docs/latest/commands/expire/): the semantics of volatile keys,
which commands keep or clear a timeout, and how expired keys are actually collected — the three
paragraphs this whole mechanism stands on.
`;
