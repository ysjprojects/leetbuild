import type {Source} from '@/lib/types';

/** The failure-mode guide for reads that tell the truth, rendered at `/guides/honest-reads`. */
export const guide = `# A read that looks right and is not

The read endpoint at the end of a course looks like the easy step: one \`GET\` that loads a record.
It is where a system tells people what is true, and they act on it: an operator staffs a queue
from its depth, a team ships the variant the report calls the winner. A read that is wrong in a
plausible way does more damage than one that fails, because nobody checks a number that looks fine.

The smallest instance:

\`\`\`python
@app.get("/v1/jobs/{job_id}")
def read_job(job_id, cache):
    body = cache.get(f"job:{job_id}")          # whose job? which version?
    if body is None:
        body = summarise(store.load(job_id))   # any tenant's job, by id alone
        cache.set(f"job:{job_id}", body, ex=600)
    return body                                 # "done" because the segments look done
\`\`\`

Every line answers a request, and every line can lie:

- **Whose data.** The id is the only key, so a caller who guesses another tenant's id reads it.
- **How old.** The body is ten minutes old, and nothing in the answer says so.
- **Which copy.** The cache key leaves out the tenant and the version, so two callers who should see
  different answers share one.
- **What it means.** \`summarise\` decides "done" from a derived view instead of the record that owns
  the state.

An honest read answers four questions correctly: who may see this, how fresh it is, what the number
is measured over, and how complete the answer is. When the answer to the last two is "not enough"
or "not all of it", the read says so in the response instead of rounding up to a confident
answer.

# How it shows up in the courses

The read step of nearly every debugging course starts from a handler that serves its demo
perfectly. The flaws only show under conditions the demo does not have: a second tenant, a busy
writer, a skewed distribution, a dependency that answered half the question.

- [Comments Service, step 5](/comments-service/5-read) pages a thread while people keep commenting,
  and reports a count that depends on which page you are looking at.
- [Ticket Triage, step 5](/ticket-triage/5-read) gives a queue manager a wait figure that one
  forgotten ticket can drag by an hour.
- [Experiment Platform, step 5](/experiments-platform/5-read) names a winner on whatever data it
  has, whether or not the split it measured is the split that was configured.
- [Feature Flags, step 5](/feature-flags/5-read) explains one user's flag decision with headers that
  let a shared cache hand the explanation to someone else.
- [GPU Scheduler, step 5](/gpu-scheduler/5-read) shows operators free capacity that the ledger
  booked a while ago.
- [Trace Collector, step 5](/trace-collector/5-read) returns a tidy trace because whatever did not
  fit was dropped without a word.
- [Transcription Service, step 5](/transcription-service/5-read) and
  [Chat Memory, step 5](/chat-memory/5-read) answer from data that is real but is not the data
  that decides the answer: a derived view for the status, a cache entry keyed too coarsely for the
  context.

None of these crash. Each one returns HTTP 200 with a well-formed body. The checks that catch them
set up the condition the demo lacks and compare the answer with what is actually true.

# Reads scoped to the caller

The first question is whose data this is. The answer comes from the credential, never from the
path, the query or the body: the tenant in the authenticated header, the user in the token. Every
lookup carries that scope, so a record that belongs to someone else is simply not found:

\`\`\`python
tenant = auth.tenant(request)                    # 401 when there is none
job = store.get(tenant, job_id)                  # the scope is part of the lookup
if job is None:
    return 404, {"error": "not_found"}           # missing and foreign look the same
\`\`\`

Two details matter:

- **Foreign answers like missing.** A 403 for another tenant's id tells the caller the id exists,
  which is enough to enumerate customers or confirm a leaked id. A 404 with the same body as an
  unknown id tells them nothing.
- **Scope inside the record, not only around it.** A ticket's internal notes, another user's
  labels, a reporter's identity: some fields of a record the caller may read are still not theirs.
  The projection is built per role in the response builder, not filtered by the client.

:::widget status-codes {}

:::quiz
Q: \`GET /v1/runs/r-91\` belongs to tenant B. Tenant A asks for it. Which answer leaks the least?
- [ ] 403 forbidden, so tenant A knows it lacks permission
- [x] 404 with the same body an unknown id gets
- [ ] 200 with the fields every tenant may see
> The 403 confirms that \`r-91\` exists and belongs to somebody. The 404 is indistinguishable from a typo, so the read reveals nothing about other tenants. The scope belongs inside the lookup (\`store.get(tenant, id)\`), so the foreign record is never loaded at all.
:::

# Live counters and the source of truth

A read is only as true as the copy it reads. Systems keep many copies of one fact: the ledger a
reservation path decrements, a nightly snapshot of it, a cached body, a list of the segments
written so far. Exactly one of them decides; the rest are views that lag it.

| The read wants | The source of truth | A copy that drifts |
| --- | --- | --- |
| GPUs free on a node | the ledger the placement path writes | a counter cached at the last dashboard refresh |
| comments in a thread | the thread's counter, incremented on write | the length of the page just served |
| whether a job is done | the job record's state | "every segment I can see is present" |
| a queue's depth | the queue itself, now | the routing records ever written to it |
| spend this window | the window key the limiter enforces | a total over all windows |

The rules follow from the table:

1. **Read the counter the write path writes.** If the enforcement path decrements \`stock:{sku}\`,
   the read reports \`stock:{sku}\`, not a sum over orders that someone recomputes later.
2. **Read it on every request.** A counter is cheap to read (one \`GET\`, one \`HGETALL\`); caching it
   saves microseconds and costs correctness. When a dashboard can tolerate age, the read returns
   \`updated_at\` with the value.
3. **Read related numbers together.** \`capacity\` and \`allocated\` read in two round trips can
   straddle a write and produce a free count that never existed. One \`HMGET\`, one Lua script or a
   \`MULTI\` returns them from one instant.
4. **Derive status from the record that owns it.** "Done" is a state the job record holds, set by
   the code that knows every chunk finished. Counting visible segments says done when a failed chunk
   simply left no segment.
5. **Clamp what can drift.** A counter that drifted above capacity reports \`free: 0\` and a drift
   flag, never \`free: -3\`.

\`\`\`text
HMGET node:n7 capacity allocated     → 8, 11       one instant, one reply
free = max(0, 8 - 11) = 0                         and report drift: allocated > capacity
\`\`\`

:::details Why "eventually consistent" does not excuse a stale read
Many stores are eventually consistent, and some reads may lag. The honest version names the lag:
the read returns the value with the time it was measured, or a \`stale\` flag past a bound the
product chose (a fleet position older than its freshness bound, a warehouse sync older than an
hour). What it must not do is read a slow copy when the fast one is right there, or present a copy
as live. The bug is not lag; it is lag the reader cannot see.
:::

# Caches keyed by everything that varies

A cache is a function from a key to a value. It is correct only when the value depends on nothing
but the key. Before writing a cache line, list what the answer depends on, and put every item in
the key:

| The answer depends on | So the key carries | Leave it out and |
| --- | --- | --- |
| the tenant | \`{tenant}\` | tenant B reads tenant A's cached body |
| the version (model, prompt, policy) | \`{version}\` | a rollout serves the old version's answer |
| the window or range | \`{window}\` | the 1-hour figure answers the 24-hour question |
| the newest input | \`{latest_turn}\` or a content digest | a new message never reaches the context |
| the caller's role | \`{role}\` | the operator's view reaches the customer |

\`\`\`text
context:{session}                         wrong: one entry per session forever
context:{tenant}:{session}:{last_turn}    right: a new turn is a new key, the old one ages out
\`\`\`

A key that includes the newest input is self-invalidating: nobody has to remember to delete the
old entry, because no reader will ask for it again, and its TTL reclaims the memory. A TTL alone
is not an invalidation strategy; it bounds how long a wrong answer can live. Pick it from the cost
of being stale (a config that must reflect a promotion within seconds gets seconds), and set it in
the same command that writes the value.

:::widget cache-aside {}

## The caches you do not run

The Redis cache is yours. The browser cache, the CDN and every proxy between them are not, and they
obey only the response headers ([RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html)):

| Header | Who may store the response | Use it for |
| --- | --- | --- |
| \`public, max-age=60\` | the browser and every shared cache | the same bytes for everyone: a published product page |
| \`private, max-age=30\` | the user's own browser only | one user's view, fine to reuse briefly |
| \`no-store\` | nobody | personal or sensitive data, explanations of one user's decision |
| \`no-cache\` | anyone, but revalidate before every reuse | data that must be checked each time, cheap to confirm with an ETag |

\`public\` on a personal response is the expensive mistake: the CDN stores the first user's answer
under the URL and serves it to the next user who asks the same URL. If the URL does not carry the
user (and it should not, since identity comes from the credential), every user shares one entry.
Personal data gets \`private\` at least, \`no-store\` when it must not sit on disk at all. A shared,
public response that changes with a version names the version in its \`ETag\`, so revalidation
notices a publish.

:::quiz
Q: \`GET /v1/flags/checkout/evaluation\` explains why the user in the bearer token got a flag value. It is sent with \`Cache-Control: public, max-age=60\`. What goes wrong behind a CDN?
- [ ] Nothing: the CDN keys the cache by URL and the user is in the token
- [x] The CDN stores the first user's explanation under the URL and serves it to other users for a minute
- [ ] The browser refuses to cache a response to an authenticated request
> A shared cache keys by the URL (plus whatever \`Vary\` names). The token is not in the URL, so every user's request maps to one entry. \`private, no-store\` keeps a per-user explanation out of every cache but the user's own, and here out of that one too.
:::

# Statistics that earn their verdict

A read that reports a number is making a claim about a population. Four habits keep the claim
honest.

**Median, not mean, for skewed figures.** Waits, latencies and sizes have long tails. Five tickets
waited 30, 40, 45, 50 and 60 seconds and one has waited two hours:

\`\`\`text
mean   = (30 + 40 + 45 + 50 + 60 + 7200) / 6 = 1237.5 s   about 20 minutes
median = (45 + 50) / 2                       =   47.5 s
\`\`\`

The mean describes no ticket in the queue. The median says what a typical customer waits; the
oldest item, reported separately, says what the worst one waits. Report both, and name the method.

**A minimum sample before a verdict.** Three ratings out of three positive is "100 percent
satisfied" and means nothing. Below a floor chosen in advance (50 ratings, 200 scored samples, 500
pairs), the read answers \`pending\` or \`insufficient_data\` with the count it has, not a score.

**An interval, not a point.** Variant B converted 60 of 1000 users, control 50 of 1000:

\`\`\`text
lift  = 0.060 - 0.050 = 0.010
se    = sqrt(0.05 * 0.95 / 1000 + 0.06 * 0.94 / 1000) ≈ 0.0102
95 %  = 0.010 ± 1.96 * 0.0102 = [-0.010, 0.030]
\`\`\`

The interval crosses zero: B may be better, the same or worse. A report that prints "+20 % lift"
without the interval invites a decision the data does not support.

**Sample ratio mismatch blocks the verdict.** An experiment configured 50/50 that counts 10 000
users in control and 9 600 in treatment has lost users somewhere: a redirect that drops slow
clients, a crash in one arm, a bot filter applied unevenly. A chi-square test on the counts
against the configured split catches it:

\`\`\`text
expected = 9800 each
chi2     = (200² / 9800) + (200² / 9800) ≈ 8.16      p ≈ 0.004
\`\`\`

With a p-value that small the split is broken, and every comparison downstream compares two
populations that differ in more than the treatment. Microsoft's experimentation platform requires
every test to pass this check before anyone looks at its effects
([Fabijan et al.](https://www.microsoft.com/en-us/research/articles/diagnosing-sample-ratio-mismatch-in-a-b-testing/)).

:::details Ratios over the right denominator
Many honest-statistics bugs are a wrong denominator. A hit ratio is hits over lookups, not hits over
hits plus fills. A win rate is wins over every auction seen, timeouts included, not over the
auctions that got a bid in. Fill latency averages the misses, because hits have no fill. An
acceptance rate whose accepted plus rejected does not equal the number sampled is not a rate at
all: the read answers a conflict instead. Before shipping a ratio, write the denominator in words
and check that every case the system sees lands in it exactly once.
:::

:::quiz
Q: An experiment report has 12 000 exposures in control and 11 200 in the variant, configured 50/50, and the variant's lift is significant. What should the read answer?
- [ ] The variant as the winner: the lift is significant
- [ ] The variant as the winner, with a note about the split
- [x] No winner: the sample ratio mismatch means the arms are not comparable until its cause is found
> 23 200 users split 50/50 should give about 11 600 each; a gap of 400 per arm is far outside chance (chi-square about 27.6). Whatever removed users from one arm may also be what moved the metric, so the lift is not evidence of anything. The report says why it withholds the verdict.
:::

# Pagination by cursor, with caps

An offset says "skip the first N items". Between two requests the list changes, and N now points
somewhere else:

:::sequence
{
  "participants": ["client", "comments API", "thread index", "other users"],
  "messages": [
    {"from": "client", "to": "comments API", "label": "GET ?offset=0  (page 1, newest first)", "kind": "sync"},
    {"from": "comments API", "to": "thread index", "label": "ZREVRANGE 0 19", "kind": "sync"},
    {"from": "comments API", "to": "client", "label": "c100 … c81", "kind": "reply"},
    {"from": "other users", "to": "thread index", "label": "two new comments: c101, c102", "kind": "async"},
    {"from": "client", "to": "comments API", "label": "GET ?offset=20  (page 2)", "kind": "sync"},
    {"from": "comments API", "to": "thread index", "label": "ZREVRANGE 20 39", "kind": "sync"},
    {"from": "comments API", "to": "client", "label": "c82 and c81 again, then c80 … c63", "kind": "reply"}
  ]
}
:::

Inserts at the head repeat items; deletes skip them. Offsets are also slow on large sets, since the
store walks past every skipped row. A cursor says "continue after this item":

\`\`\`text
page 1: ZREVRANGEBYSCORE thread:t1 +inf -inf LIMIT 0 20     → ..., c81 (score 1731400081)
cursor: the last item's sort key, opaque to the client
page 2: ZREVRANGEBYSCORE thread:t1 (1731400081 -inf LIMIT 0 20
\`\`\`

The exclusive bound \`(\` resumes strictly after the last item served, whatever arrived since. Ties
on the sort key need a tie-breaker (score, then id) or a cursor that encodes both.

The rest of a good page:

- **A cap on the page size.** \`limit\` defaults to something modest and is capped (100 by default,
  500 at most, for instance). An uncapped \`limit\` turns one request into a table scan.
- **An exact \`has_more\`.** Fetch \`limit + 1\` items; there is a next page only if the extra one
  exists. Guessing from a full page leaves a final empty page or misses one.
- **Totals from the counter, not the page.** \`comment_count\` comes from the thread's counter. The
  page length is 20 on page 1 and 7 on the last page.
- **An opaque cursor.** Encode it (base64 of the sort key, signed if it must not be forged) so
  clients do not do arithmetic on it, and so you can change its contents later
  ([Slack's account](https://slack.engineering/evolving-api-pagination-at-slack/) of moving from
  offsets to cursors makes the same case).
- **A bounded range.** Time-series reads require \`from\` and \`to\` and refuse a span past the limit
  with 400, before the store is asked.

:::quiz
Q: A sync endpoint pages a change log 1000 entries at a time. The starter returns \`next_cursor = offset + 1000\`. What fails when another device writes during a sync?
- [ ] Nothing: the log is append-only, so offsets are stable
- [x] Offsets count positions in whatever the query sees now, so a compaction or a filtered view shifts them and entries are skipped or repeated; a cursor of the last revision returned resumes exactly
- [ ] The client gets a 409 and must restart the sync
> Offsets are stable only when nothing before them ever changes. A cursor that names the last revision delivered (\`revision > 4812\`) is stable under inserts, deletes and compaction, and \`has_more\` from a \`limit + 1\` read is exact.
:::

# Partial, pending, stale and degraded, said out loud

The most tempting lie is the tidy one: drop what did not fit, default what did not answer, and
return something that looks complete. An honest read keeps the shape of what it does not know:

| State | What happened | What the read says |
| --- | --- | --- |
| pending | the work has not finished | \`202\` or \`status: "pending"\` with progress, never a result |
| partial | some parts failed or are missing | \`partial: true\` and the list of gaps (failed shards, missing parent spans, uncovered categories) |
| stale | the data is older than its bound | \`stale: true\` and the age or \`updated_at\` |
| degraded | a fallback answered | the source (\`fallback\`, \`cached\`), and the share of answers it produced |
| truncated | the answer hit a cap | \`truncated: true\` and the cap |
| gone | the result expired | \`410\` with the metadata that is left |

\`\`\`python
spans = assembly.load_trace(tenant, trace_id)
ids = {s.span_id for s in spans}
gaps = sorted({s.parent_id for s in spans if s.parent_id and s.parent_id not in ids})
return {"spans": spans, "gaps": gaps, "partial": bool(gaps)}   # every span, and what is missing
\`\`\`

Each of these costs a field or two. Leaving them out moves the cost to the reader, who learns
about the gap during an incident review or a customer escalation. The same rule covers verdicts:
a red-team run with incomplete coverage does not report \`pass\`, a batch with a failed shard is not
\`completed\`, and a purge that some edges have not confirmed is \`accepted\`, not \`propagated\`.

:::details Partial is not an error
A partial answer is usually still a 200: the caller asked for the trace and got every span the
system has. Turning it into a 5xx hides the useful part; turning it into a clean 200 hides the
missing part. The field is the honest middle. The exceptions are states where the answer would be
wrong rather than incomplete: a result that does not exist yet (\`202\` or \`409\`), a result whose
counts do not reconcile (\`409\`), a result that expired (\`410\`).
:::

# The fix and its trade-offs

Put together, an honest read handler has a recognisable order:

1. **Identify the caller** from the credential; 401 without one.
2. **Validate the request**: bounded range, capped page size, a window from a fixed set; 400
   before any read.
3. **Look up inside the caller's scope**; 404 for missing and foreign alike.
4. **Read the source of truth**: the live counter, the record that owns the state, related values
   in one command.
5. **Compute honestly**: the right denominator, the median for skewed figures, an interval, a
   sample floor and a ratio check before any verdict.
6. **Describe completeness**: pending, partial, stale, degraded, truncated, with what is missing.
7. **Cache with a full key and the right headers**: tenant, version, window and latest input in the
   key, a TTL bounded by the cost of staleness, \`private\` or \`no-store\` for personal data.

What it costs:

| Choice | Cost | Why it is usually worth it |
| --- | --- | --- |
| live counters | one extra round trip per read | counters are O(1); a stale capacity figure misplaces real work |
| fine-grained cache keys | lower hit ratio, more entries | every miss is correct; TTLs reclaim the old entries |
| \`no-store\` on personal reads | no browser or CDN reuse | personal reads are rarely hot; a leak is permanent |
| sample floors and intervals | slower verdicts, more "inconclusive" | a wrong winner ships and stays shipped |
| cursors | no "jump to page 37" | clients that walk a list need completeness, not page numbers |

An expensive figure (a percentile over millions of rows) is precomputed on the write path, or
cached with its \`updated_at\`, never replaced by a cheap figure that looks like it.

# Proving the fix

The demo already passes, so a proof has to recreate the condition the demo lacks and assert on
outcomes, not on the code's shape:

- **Two tenants.** Seed the same id shape for tenants A and B; read B's record as A and compare the
  response, status and body, byte for byte with the response for an id that does not exist.
- **A write between reads.** Read the counter, perform the write the enforcement path performs,
  read again: the second read moves by exactly the write. Do the same with the cache warm, so a
  stale entry would show.
- **A key per variant.** Warm the cache as tenant A or version 1, read as tenant B or version 2, and
  assert the answer belongs to B or version 2. Read the response headers and assert \`private\` or
  \`no-store\` on every personal route.
- **Skew and small samples.** Seed one outlier and assert the reported figure is the median. Seed
  fewer samples than the floor and assert no verdict, with the count. Seed a 50/50 experiment with a
  broken split and assert no winner.
- **Pages under writes.** Read page 1, insert at the head and delete from the middle, read on to the
  end, and assert every surviving item appeared exactly once, \`has_more\` was false only on the last
  page, and no page exceeded the cap.
- **Something missing.** Fail one shard, drop one parent span, let one fallback answer, age the
  data past its bound, and assert the read names each: \`partial\`, \`gaps\`, \`degraded\`, \`stale\`.

A good proof fails against the starter, passes after the fix, and asserts facts a user depends
on: "tenant A cannot tell B's job exists", "no winner on a broken split".

:::quiz
Q: Which test proves that a stock read uses the live counter rather than a cached copy?
- [ ] Assert that the handler calls \`redis.get\` and not \`cache.get\`
- [ ] Read the stock twice and assert both reads agree
- [x] Read the stock, reserve two units through the reservation path, read again, and assert the second read is two lower
> The first option tests the code's shape, which a refactor can change without changing behaviour. The second passes for a stale cache, because both reads hit the same stale entry. The third sets up the condition (a write between reads) and asserts the outcome the storefront depends on.
:::
`;

export const sources: Source[] = [
  {
    title: 'Cache-Control header',
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control',
    kind: 'docs',
    venue: 'MDN Web Docs',
    takes:
      'What public, private, no-store, no-cache and max-age let browsers and shared caches do, and why a personal response must not be public.',
  },
  {
    title: 'RFC 9111: HTTP Caching',
    url: 'https://www.rfc-editor.org/rfc/rfc9111.html',
    kind: 'docs',
    venue: 'IETF',
    by: 'R. Fielding, M. Nottingham, J. Reschke',
    date: '2022-06',
    takes:
      'The rules a shared cache follows: a response is stored and reused under its URL unless its directives forbid it, which is why identity in a token never reaches the cache key.',
  },
  {
    title: 'Evolving API Pagination at Slack',
    url: 'https://slack.engineering/evolving-api-pagination-at-slack/',
    kind: 'post',
    venue: 'Engineering at Slack',
    by: 'Michael Hahn',
    date: '2017-08-15',
    takes:
      'Why offset pagination repeats and skips items on a changing dataset and slows down on large ones, and how opaque cursors over a sort key fix both.',
  },
  {
    title: 'Diagnosing Sample Ratio Mismatch in A/B Testing',
    url: 'https://www.microsoft.com/en-us/research/articles/diagnosing-sample-ratio-mismatch-in-a-b-testing/',
    kind: 'post',
    venue: 'Microsoft Research',
    by: 'Aleksander Fabijan et al., Microsoft Experimentation Platform',
    date: '2020-09-14',
    takes:
      'A split that differs from its configuration is a symptom of lost users, and every test must pass the sample ratio check before its effects are read.',
  },
];
