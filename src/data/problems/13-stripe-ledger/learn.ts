/**
 * The learning guide for Ledger: the concepts the six steps rest on, in the order a reader meets
 * them — double entry, an immutable journal, idempotency keys, events through Kafka, insert-or-skip,
 * clearing and balances as a fold — a figure or a demo where one says it faster than prose, a pop
 * quiz per section. Rendered at `/stripe-ledger/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

Stripe's **Ledger** is where every system that moves money — captures, payouts, refunds, disputes — has
to agree on what happened. It agrees by refusing anything that does not balance, by never editing what
it recorded, and by watching the accounts where money sits in transit until they come back to zero. The
course rebuilds its write path and its clearing check:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Internal callers", "sub": "POST /transactions", "x": 8, "y": 30},
    {"id": "api", "kind": "http", "label": "ledger", "sub": "steps 1–2 · validate, reserve the key, write", "x": 26, "y": 30},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "idem:{key} · clearing:open · bal:{acct}:{ccy}", "x": 48, "y": 8},
    {"id": "db", "kind": "db", "label": "Postgres", "sub": "the journal: transactions · entries", "x": 48, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "money-events", "sub": "from the payment systems · key = event id", "x": 8, "y": 72},
    {"id": "ingest", "kind": "service", "label": "ledger-ingest", "sub": "steps 3–4 · map, insert or skip, commit", "x": 26, "y": 72},
    {"id": "dead", "kind": "kafka", "label": "money-events.dead", "sub": "unknown types, for a human", "x": 26, "y": 94},
    {"id": "balance", "kind": "grpc", "label": "LedgerService", "sub": "step 6 · GetBalance behind a 5 s cache", "x": 70, "y": 50},
    {"id": "reports", "kind": "client", "label": "Reporting", "sub": "GetBalance(account, ccy, as_of) · clearing dashboards", "x": 92, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "SET NX EX · HSET · ZADD"},
    {"from": "api", "to": "db", "kind": "plain", "label": "transactions + entries (1 tx)"},
    {"from": "kafka", "to": "ingest", "kind": "kafka", "label": "consume"},
    {"from": "ingest", "to": "dead", "kind": "kafka", "label": "produce"},
    {"from": "ingest", "to": "db", "kind": "plain", "label": "INSERT … ON CONFLICT DO NOTHING"},
    {"from": "ingest", "to": "redis", "kind": "redis", "label": "ZADD · ZREM · DEL bal"},
    {"from": "reports", "to": "balance", "kind": "grpc", "label": "GetBalance"},
    {"from": "balance", "to": "redis", "kind": "redis", "label": "GET / SET EX 5"},
    {"from": "balance", "to": "db", "kind": "plain", "label": "SUM(amount)"}
  ]
}
:::

- **Post** (steps 1–2): an HTTPS API accepts only double entry and promises one outcome per
  \`Idempotency-Key\`.
- **Ingest** (steps 3–4): the systems that move money publish events to Kafka; a consumer maps each one
  to a balanced transaction and the journal refuses a second copy.
- **Clear** (step 5): a transaction that touches a \`clearing:*\` account is tracked until a later one
  settles it; what sits there over 24 h is the stuck-money report.
- **Read** (step 6): balances are a sum over the journal, over gRPC, behind a five-second cache.

# Double entry: a transaction is entries that net to zero

[Double-entry bookkeeping](https://en.wikipedia.org/wiki/Double-entry_bookkeeping) is the only known way
to keep money from appearing or vanishing in a record: every movement is written as at least two
**entries** on different **accounts**, and the entries sum to zero. A captured payment, as the course
posts it:

\`\`\`json
POST /transactions
{"description": "capture ch_1",
 "entries": [{"account": "cash:acquirer",     "currency": "EUR", "amount": 4999},
             {"account": "clearing:payments", "currency": "EUR", "amount": -4999}]}
\`\`\`

- A **debit** is positive, a **credit** negative — the whole accounting vocabulary the course needs.
- Amounts are **integers in minor units**: \`0.1 + 0.2 ≠ 0.3\` in a float, and a ledger that sums floats
  drifts by cents until it fails a clearing check. A **zero** entry moves nothing and hides a bug.
- One **currency** per transaction, \`^[A-Z]{3}$\`.

The API validates all of that before any I/O, and names the rule it failed on:

| Body | Answer |
| --- | --- |
| One entry, or an entry without an account | \`422 {"error": …}\` |
| \`"amount": 49.99\`, \`"49.99"\`, \`true\`, \`0\` | \`422\` — not an integer in minor units |
| \`EUR\` and \`USD\` in one transaction, or \`"eur"\` | \`422\` — one currency, three capitals |
| \`+4999\` and \`-4990\` | \`422\` — debits and credits do not net to zero |
| Balanced | \`201\`, \`Location: /transactions/{id}\`, \`{transaction_id, posted_at, entries}\` |

**422, not 400.** The JSON parsed and the request was understood; it is the *content* the ledger cannot
accept, and the reason in the body is what the posting team's engineer reads in their logs.

:::widget status-codes {}

:::quiz
Q: A producer posts \`[{cash:acquirer, +4999}, {clearing:payments, -4990}]\`. The nine cents are a rounding artefact in their code. What should the ledger do?
- [ ] Accept it and log the difference; nine cents is immaterial
- [x] Refuse it with 422 and the reason; a ledger that holds one unbalanced transaction can no longer vouch for any balance
- [ ] Accept it and add a nine-cent entry on a suspense account
> One unbalanced transaction means the sum of all accounts is no longer zero, and from then on no clearing check can tell a real discrepancy from the known one. The producer fixes the rounding; the ledger does not absorb it.
:::

# An immutable journal

Stripe describes Ledger as a **log that nothing may edit**: an event becomes a transaction, its entries
move balances between accounts, and any past state is reproducible by replaying the log. The course's
journal is two tables and one kind of write — an insert:

\`\`\`sql
transactions (id text primary key, event_id text unique, description text, settles text, posted_at bigint)
entries      (transaction_id text, account text, currency text, amount bigint, posted_at bigint)
\`\`\`

- **No** \`UPDATE\`**, no** \`DELETE\`**.** A mistake is corrected by a new transaction that reverses it;
  both stay in the record. A ledger you can edit is a ledger you can no longer audit.
- **Rows carry the event's own time.** \`posted_at\` is \`occurred_at\` from the event when there is one,
  now only on the API path; the same value goes into the transaction row and every entry row.
- **A balance is a fold.** \`SUM(amount)\` over an account's entries with \`posted_at <= as_of\` — and
  because nothing is ever edited, the same number whenever you ask.
- **Row and entries land together** in one database transaction; a reader never sees half a posting.

Event time rather than arrival time is what makes the rest of the course work: events reach the journal
out of order — after a replay, a day late — and the balance "as of Tuesday" is still the sum of what was
posted up to Tuesday, whenever it arrived.

:::quiz
Q: A capture was booked against the wrong merchant. How does an immutable ledger fix it?
- [ ] An authorised operator updates the entry's account
- [x] A new transaction reverses the wrong one and a third books it correctly; all three stay in the journal
- [ ] The transaction is deleted and re-inserted with the right account
> The state at any time must be recomputable from the log, which an in-place edit breaks. The reversal is a normal balanced transaction, and the balance as of the day of the mistake still shows the mistake — because that is what the books said that day.
:::

# One Idempotency-Key, one outcome

Every system that posts to the ledger retries on timeout, and a timeout says nothing about whether the
first attempt was written. A retried \`POST\` that books the money twice is the worst bug a ledger can
have, so the API borrows the protocol of Stripe's public API: the client picks an **idempotency key**
and the server promises that one key produces one outcome.

:::sequence
{
  "participants": ["Caller", "ledger", "Redis"],
  "messages": [
    {"from": "Caller", "to": "ledger", "label": "POST /transactions · Idempotency-Key: k1", "kind": "sync"},
    {"from": "ledger", "to": "Redis", "label": "SET idem:k1 sha256(body) NX EX 86400 → OK", "kind": "sync"},
    {"from": "ledger", "to": "ledger", "label": "handle(body) → (201, payload)", "kind": "sync"},
    {"from": "ledger", "to": "Redis", "label": "HSET idem:k1:response status 201 body {…} · EXPIRE 86400", "kind": "sync"},
    {"from": "ledger", "to": "Caller", "label": "201 {transaction_id: tx_7f3a}", "kind": "reply"},
    {"from": "Caller", "to": "ledger", "label": "POST /transactions · Idempotency-Key: k1 (retry)", "kind": "sync"},
    {"from": "ledger", "to": "Redis", "label": "SET NX refused · GET idem:k1 = same fingerprint · HGETALL idem:k1:response", "kind": "sync"},
    {"from": "ledger", "to": "Caller", "label": "201 {transaction_id: tx_7f3a} · Idempotent-Replayed: true", "kind": "reply"},
    {"from": "Caller", "to": "ledger", "label": "POST /transactions · Idempotency-Key: k1 (other body)", "kind": "sync"},
    {"from": "ledger", "to": "Caller", "label": "409 key reused with a different request", "kind": "reply"}
  ]
}
:::

The reservation is one atomic command; its refusal branches into three cases:

| \`SET idem:{key} {fingerprint} NX EX 86400\` | Stored fingerprint | Stored outcome | Answer |
| --- | --- | --- | --- |
| OK — the key is yours | — | — | run \`handle\`, store \`{status, body}\`, answer |
| refused | differs | — | **409** — a key reused for a different request |
| refused | same | present | **replay** it, same status and body, \`Idempotent-Replayed: true\` |
| refused | same | not yet | **409** — the first request is still running |

- **The fingerprint** — SHA-256 of the canonical JSON, keys sorted, no whitespace — turns the key from a
  promise about a string into a promise about a *request*; without it a badly generated key gets a
  confident \`201\` for a transaction that was never checked.
- **Every outcome is stored, a 422 included.** A rejected posting re-run on retry might pass the second
  time, and the caller would never learn it had been rejected.
- **No header → 400.** **A crash releases the key**: if \`handle\` throws, the reservation is deleted
  before the error is re-raised. **24 h expiry** on both keys keeps the store bounded.

:::widget idempotency {}

:::details What Stripe's own API does differently
The course keeps the shape of
[*Designing robust and predictable APIs with idempotency*](https://stripe.com/blog/idempotency) and
changes the details: Stripe scopes keys **per API key**, answers a reused key with a different body as
a **400** rather than a 409, keeps keys for **24 hours**, and asks clients to retry with exponential
backoff and jitter. The advice that matters most is where the key comes from: generate it once per
**intent** — a UUID stored next to the order before the first attempt — never per attempt.
:::

:::quiz
Q: A client's first request was refused with 422 (unbalanced entries). It retries with the same key and the same body. What should it get?
- [ ] The request is validated again; if it still fails, 422
- [x] The stored 422, replayed, with \`Idempotent-Replayed: true\`
- [ ] 409, because the key is already used
> One key, one outcome — including the bad ones. Re-running it would let a rejection quietly turn into a posting if the rules moved in between, and the client would never learn its first attempt had failed.
:::

# Events, not calls: ingesting money movement

Most of the journal is not posted over HTTPS. The systems that move money publish **events** to the
\`money-events\` topic, keyed by event id, and a consumer in group \`ledger\` turns each one into a
balanced transaction:

\`\`\`json
{"event_id": "evt_01", "type": "payment.captured", "amount": 4999, "currency": "EUR",
 "occurred_at": 1700000000000, "charge": "ch_1"}
\`\`\`

The producer says *what happened*; a **mapping** says which accounts that moves money between:

| Event type | Debit (+amount) | Credit (−amount) |
| --- | --- | --- |
| \`payment.captured\` | \`cash:acquirer\` | \`clearing:payments\` |
| \`payout.sent\` | \`clearing:payouts\` | \`cash:bank\` |
| \`refund.issued\` | \`clearing:payments\` | \`cash:acquirer\` |

The mapping is the course's stand-in for Stripe's **fund flows**: a declaration kept out of the
consumer's code, so adding a producer is a data change. Its two entries — \`+amount\` on the first
account, \`−amount\` on the second — are balanced by construction.

:::sequence
{
  "participants": ["Kafka", "ledger-ingest", "Postgres", "money-events.dead"],
  "messages": [
    {"from": "Kafka", "to": "ledger-ingest", "label": "evt_01 payment.captured 4999 EUR", "kind": "async"},
    {"from": "ledger-ingest", "to": "ledger-ingest", "label": "MAPPING → [+4999 cash:acquirer, −4999 clearing:payments]", "kind": "sync"},
    {"from": "ledger-ingest", "to": "Postgres", "label": "write_transaction(entries, event_id=evt_01, posted_at=occurred_at)", "kind": "sync"},
    {"from": "ledger-ingest", "to": "Kafka", "label": "commit offset — after the write", "kind": "sync"},
    {"from": "Kafka", "to": "ledger-ingest", "label": "evt_02 dispute.opened 4999 EUR", "kind": "async"},
    {"from": "ledger-ingest", "to": "money-events.dead", "label": "produce evt_02 (original key + value) · header reason: unmapped type · flush", "kind": "async"},
    {"from": "ledger-ingest", "to": "Kafka", "label": "commit offset", "kind": "sync"}
  ]
}
:::

The consumer's job is ordering and failure handling. Three branches per record:

1. **Cannot parse, or no mapping** → produce the *original* key and value to \`money-events.dead\` with a
   \`reason\` header, **flush**, then commit. Flush first, or a crash between the two loses the only copy
   you parked.
2. **Write succeeds** → commit this message's offset.
3. **Write throws** → re-raise without committing. The record comes back.

Auto-commit is off: with it, the offset could be committed before the write, and a crash in between
would lose an event. Committing after the write means a crash **redelivers** instead — *at-least-once*
by design; the next section is where the duplicate is made harmless.

:::widget consumer-groups {"partitions": 3}

The [dead-letter topic](https://en.wikipedia.org/wiki/Dead_letter_queue) is the consumer saying *I do
not know what this is* — different from *this failed*. The first is parked and committed so the
partition keeps flowing; the second is retried. Stripe calls this the long tail: the tiny fraction of
events that need a human, kept out of the way of the billions that do not. Real pipelines version the
mappings and alert on the dead-letter topic's *growth rate* rather than on every record.

:::quiz
Q: A new producer starts publishing \`dispute.opened\`, which has no mapping yet. What should the consumer do with the first one?
- [ ] Stop and alert; an unmapped event means the ledger is incomplete
- [x] Park it on \`money-events.dead\` with the reason, commit, and carry on with the next record
- [ ] Skip it and commit; the producer will republish once the mapping exists
> Stopping holds every payment and payout behind one dispute until an engineer wakes up; skipping loses the event. Parking keeps the original bytes where a human can replay from once the mapping exists.
:::

# Exactly once in effect: the journal refuses the second copy

The consumer commits after it writes, so a crash in between — or a rebalance that hands the partition
to a second consumer, or a producer that published the same event twice — delivers an event again.
[Kafka's delivery guarantees](https://kafka.apache.org/documentation/#semantics) are about the
broker and the consumer; what a ledger needs is *exactly once in effect*, and that is enforced where
the effect happens: a unique index on \`event_id\` in the journal.

:::sequence
{
  "participants": ["ledger-ingest", "Postgres", "clearing", "balance cache"],
  "messages": [
    {"from": "ledger-ingest", "to": "Postgres", "label": "BEGIN", "kind": "sync"},
    {"from": "ledger-ingest", "to": "Postgres", "label": "INSERT transactions (evt_01) ON CONFLICT (event_id) DO NOTHING → 1 row", "kind": "sync"},
    {"from": "ledger-ingest", "to": "Postgres", "label": "INSERT entries ×2 (posted_at = occurred_at)", "kind": "sync"},
    {"from": "ledger-ingest", "to": "Postgres", "label": "COMMIT", "kind": "sync"},
    {"from": "ledger-ingest", "to": "clearing", "label": "track(tx_7f3a, occurred_at, entries) — after the commit", "kind": "async"},
    {"from": "ledger-ingest", "to": "balance cache", "label": "invalidate(cash:acquirer, EUR) · invalidate(clearing:payments, EUR)", "kind": "async"},
    {"from": "ledger-ingest", "to": "Postgres", "label": "INSERT transactions (evt_01) … DO NOTHING → 0 rows (redelivery)", "kind": "sync"},
    {"from": "Postgres", "to": "ledger-ingest", "label": "None: no entries, no hooks", "kind": "reply"}
  ]
}
:::

\`\`\`sql
INSERT INTO transactions (id, event_id, description, settles, posted_at)
VALUES (…) ON CONFLICT (event_id) DO NOTHING
\`\`\`

- **The affected row count is the whole decision.** One row inserted → write the entries. Zero rows →
  the event is already in the journal: return \`None\`, write nothing, let the empty transaction commit.
  Postgres's [\`ON CONFLICT DO NOTHING\`](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)
  turns a constraint *error* into a *result* you can branch on.
- **API transactions have no event id.** A \`NULL\` never conflicts, so they are always written; their
  idempotency lives in the key from two sections ago.
- **Row and entries in one database transaction**, so a crash mid-write rolls back both.
- **Hooks after the commit, never inside it.** \`track\` and \`invalidate\` talk to Redis, which is not
  part of the database transaction: called inside, a rollback would leave a clearing item no settlement
  could ever close, and a slow Redis would hold the database transaction open. A duplicate calls neither.

:::widget delivery-semantics {}

Consumer-side deduplication is lost on a crash and a Kafka transaction covers the broker but not
Postgres; the unique index sits where the effect is, so there is no window between "checked" and
"written". It is the shape Stripe describes: the only write is an insert, the only conflict resolution
*already there*.

:::quiz
Q: During a rebalance two consumers briefly own the same partition and both process \`evt_01\`. What keeps it from being booked twice?
- [ ] The consumer group guarantees one owner per partition at all times
- [x] The second \`INSERT\` conflicts on \`event_id\`, inserts zero rows, and the writer stops there
- [ ] The first consumer's offset commit arrives before the second consumer reads
> Group membership is a lease, and leases overlap at the edges. Neither consumer can know about the other; the database can, because the event id is unique in the journal. The duplicate writes no entries and fires no hooks.
:::

# Clearing: money in transit must come back to zero

A captured payment lands in \`clearing:payments\`; later a payout moves it on. **Clearing accounts** hold
money in transit, and at steady state they are empty. When the next event of a flow is missing, late or
mislabelled, the money sits there — and that is how a ledger finds a broken pipeline without knowing
anything about the pipeline. Stripe's whole detection query is *find the clearing accounts with a
nonzero balance*.

One flow, three transactions, two clearing accounts:

| Transaction | Entries | \`clearing:payments\` | \`clearing:payouts\` | Open in \`clearing:open\` |
| --- | --- | --- | --- | --- |
| \`tx_7f3a\` capture, \`T0\` | \`+4999 cash:acquirer\` · \`−4999 clearing:payments\` | −4999 | 0 | \`tx_7f3a\` |
| \`tx_9c21\` settles \`tx_7f3a\`, \`T0 + 2 h\` | \`+4999 clearing:payments\` · \`−4999 clearing:payouts\` | 0 | −4999 | — |
| payout, settles \`tx_9c21\` | \`+4999 clearing:payouts\` · \`−4999 cash:bank\` | 0 | 0 | — |

The course tracks open positions in a sorted set rather than summing the accounts on every look, and the
rule that makes the set converge is that a settling transaction **closes** a position, never opens one:

:::sequence
{
  "participants": ["journal writer", "Redis", "Reporting"],
  "messages": [
    {"from": "journal writer", "to": "Redis", "label": "track(tx_7f3a, T0, [+4999 cash:acquirer, −4999 clearing:payments])", "kind": "sync"},
    {"from": "journal writer", "to": "Redis", "label": "ZADD clearing:open T0 tx_7f3a — touches clearing:*, score = its own time", "kind": "sync"},
    {"from": "journal writer", "to": "Redis", "label": "track(tx_9c21, T0 + 2 h, […], settles = tx_7f3a)", "kind": "sync"},
    {"from": "journal writer", "to": "Redis", "label": "ZREM clearing:open tx_7f3a", "kind": "sync"},
    {"from": "Reporting", "to": "Redis", "label": "GET /clearing/stuck → ZRANGEBYSCORE clearing:open -inf (now − 86400000) WITHSCORES", "kind": "sync"},
    {"from": "Redis", "to": "Reporting", "label": "200 [{tx_1a07, opened_at, age_s: 97200}]", "kind": "reply"}
  ]
}
:::

- **Settling closes.** \`settles\` present → \`ZREM\` and stop. Removing a member that is not there is a
  no-op, and that is the point: the settling transaction may arrive before the one it settles was tracked.
- **Touching clearing opens.** Otherwise, any entry on a \`clearing:*\` account →
  \`ZADD clearing:open {transaction_id: posted_at}\`. The score is the transaction's **own** time, so an
  event that reaches the journal a day late is already overdue.
- **Stuck = a range query.** \`ZRANGEBYSCORE clearing:open -inf (now − 86400000)\`, with scores, oldest
  first, answered as \`[{transaction_id, opened_at, age_s}]\` by \`GET /clearing/stuck\`. The 24-hour cutoff
  is Stripe's *timeliness* window expressed as a score.
- **The report never removes.** Someone has to decide whether a stuck item is a missing event, a
  mislabelled one or a real operational problem.

Every flow adds one item on its way in and removes it on its way out, so the set's size is the number
of flows in transit. Real trackers also keep the open *balance* per account and currency, alert on the
aged balance rather than the count, and re-open an item when a correction reverses its settlement.

:::quiz
Q: A \`payout.sent\` event arrives 30 hours after it occurred, having been stuck in the producer's outbox. Which time should its clearing entry carry?
- [x] \`occurred_at\` — so it shows up in the stuck report immediately, because the money really has been in transit for 30 hours
- [ ] The arrival time — so the producer's delay does not count against the ledger
- [ ] Now, when the stuck report is generated
> The clock started when the event happened, not when the ledger heard about it. Scoring by arrival time would hide exactly the class of failure — late events — the check exists to surface.
:::

# Balances are a fold over the journal

Reporting, reconciliation and the clearing dashboards all ask one question: what is the balance of an
account? \`LedgerService.GetBalance\` answers it over gRPC, and the answer is a sum — the account's
entries in that currency with \`posted_at <= as_of\`:

\`\`\`proto
service LedgerService {
  rpc GetBalance(BalanceRequest) returns (Balance);
}
message BalanceRequest { string account = 1; string currency = 2; int64 as_of = 3; }  // as_of 0 = now
message Balance        { string account = 1; string currency = 2; int64 amount = 3; int64 as_of = 4; }
\`\`\`

:::sequence
{
  "participants": ["Reporting", "LedgerService", "Redis", "Postgres"],
  "messages": [
    {"from": "Reporting", "to": "LedgerService", "label": "GetBalance(cash:acquirer, EUR, as_of = 0)", "kind": "sync"},
    {"from": "LedgerService", "to": "Redis", "label": "GET bal:cash:acquirer:EUR → nil", "kind": "sync"},
    {"from": "LedgerService", "to": "Postgres", "label": "SELECT SUM(amount) FILTER (currency, posted_at ≤ now), COUNT(*) WHERE account = …", "kind": "sync"},
    {"from": "Postgres", "to": "LedgerService", "label": "3499 · 4 entries", "kind": "reply"},
    {"from": "LedgerService", "to": "Redis", "label": "SET bal:cash:acquirer:EUR 3499 EX 5", "kind": "sync"},
    {"from": "LedgerService", "to": "Reporting", "label": "Balance{amount: 3499, as_of: now}", "kind": "reply"},
    {"from": "Reporting", "to": "LedgerService", "label": "GetBalance(cash:acquirer, EUR, as_of = T0)", "kind": "sync"},
    {"from": "LedgerService", "to": "Postgres", "label": "SELECT … posted_at ≤ T0 (cache bypassed)", "kind": "sync"},
    {"from": "LedgerService", "to": "Reporting", "label": "Balance{amount: 4999, as_of: T0}", "kind": "reply"}
  ]
}
:::

- **Current balance** (\`as_of = 0\`) goes through Redis: \`GET bal:{account}:{currency}\`, on a miss the
  sum up to now, then \`SET … EX 5\`.
- **Point in time** (\`as_of > 0\`) sums \`posted_at <= as_of\` and bypasses the cache in both directions:
  the answer never changes, and caching it under the current key would poison the current balance.
- **Writers invalidate.** Every committed transaction calls \`invalidate(account, currency)\` — a \`DEL\` of
  the key — for every entry, so a write is visible on the next read. The five-second TTL only bounds how
  long a *missed* invalidation can last.
- **One query answers "balance" and "does this account exist".** \`SUM(amount)\` filtered to the currency
  and the time, and \`COUNT(*)\` over all the account's entries, in one row: a count of zero is
  \`NOT_FOUND\`; a known account with no entries in the asked currency is \`0\`.
- **Validate before any lookup.** An empty account, or a currency that is not \`^[A-Z]{3}$\`, is
  \`INVALID_ARGUMENT\`.

:::widget cache-aside {}

The read side can be cached this aggressively and this briefly because the balance is a fold over an
append-only log: the only thing that changes it is an append, and the writer knows exactly when that
happens. Real balance services keep running balances as a materialised view and snapshot them nightly,
so a historical query folds a day of entries instead of years.

:::quiz
Q: Why does a point-in-time request (\`as_of > 0\`) bypass the cache in both directions?
- [ ] Historical queries are rare, so caching them is not worth the memory
- [x] Its answer never changes, so there is nothing to invalidate — and writing it under \`bal:{account}:{currency}\` would serve a stale number as the current balance
- [ ] Postgres is faster than Redis for sums over an index
> The cache absorbs reads of a number that changes on every write and is deleted when it does. "The balance as of Tuesday" has neither property: the journal is immutable, so the fold up to Tuesday is fixed — and the only cache key in play is the one the current balance lives under.
:::

# What to take away

- **Refuse what does not balance.** Two or more entries, integers in minor units, one currency, a sum of
  zero — checked before any I/O, each failure named.
- **Append, never edit.** Corrections are new transactions; rows carry the event's own time; any past
  state is a fold over the log, and everything else is computed from it.
- **One key, one outcome.** Reserve the \`Idempotency-Key\` atomically with a fingerprint of the body,
  store every outcome including the rejections, replay on retry, refuse a reused key.
- **Make duplicates harmless where the effect happens.** Commit after the write, accept redelivery, and
  let \`INSERT … ON CONFLICT (event_id) DO NOTHING\` and the row count decide. Park what you do not
  understand instead of stopping.
- **Money in transit must come back to zero.** Track every transaction that touches a clearing account
  by its own time, remove it when a later one settles it, report what has sat there over 24 h.

The primary source is Stripe's
[*Ledger: Stripe's system for tracking and validating money movement*](https://stripe.com/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)
(Ilya Ganelin, 2024): the immutable double-entry log, fund flows as state machines, and clearing,
timeliness and completeness as the three questions the data-quality platform asks of it.
`;
