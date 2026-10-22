/**
 * The learning guide for the conditional-requests drill: validators, the RFC 9110 §13.2.2 precedence
 * table, weak versus strong comparison, 304 versus 412 versus 428, optimistic concurrency against the
 * lost update, and what caches do with all of it. Rendered at `/http-conditional-requests/learn`.
 */
export const learn = `# The mechanism at a glance

A **conditional request** carries a condition about the server's current copy of a resource, and the server
performs the method only if the condition holds. The condition is written in terms of **validators**: an
\`ETag\` (an opaque version tag) and a \`Last-Modified\` date that the server handed out earlier. Caches use
conditions to ask "has it changed?" and get a bodiless 304; writers use them to say "replace it only if it is
still the version I read" and get a 412 when it is not.

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Clients and caches", "sub": "send back ETag and Last-Modified", "x": 22, "y": 50},
    {"id": "service", "kind": "service", "label": "docs API", "sub": "DOCS · id -> text, etag, modified", "x": 72, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "service", "kind": "http", "label": "GET / PUT / DELETE /docs/{id} + If-* headers"}
  ]
}
:::

The contract the drill implements:

- \`GET\`, \`PUT\` and \`DELETE\` on \`/docs/{id}\`; the PUT body is \`{"text": …}\`; a module-level store maps an
  id to \`{text, etag, modified}\`.
- \`ETag\` is strong: the first 16 hex digits of \`sha256(text)\`, quoted. \`Last-Modified\` is the IMF-fixdate of
  the virtual clock at write time, in whole seconds.
- GET and DELETE on a missing doc answer 404 before any condition is looked at.
- Then four conditions in RFC order, ending in 304 or 412; a write to an existing doc without \`If-Match\`
  answers 428; \`If-None-Match: *\` makes a PUT create-only.

# Validators: what a version looks like on the wire

A validator is metadata the server can compare cheaply against what the client sends back. HTTP has two.

| | \`ETag\` | \`Last-Modified\` |
| --- | --- | --- |
| Shape | quoted opaque string, optional \`W/\` prefix | IMF-fixdate, e.g. \`Thu, 22 Oct 2026 10:00:00 GMT\` |
| Resolution | exact: any change gives a new tag | one second |
| Request headers | \`If-Match\`, \`If-None-Match\` | \`If-Unmodified-Since\`, \`If-Modified-Since\` |
| In the drill | \`"\` + 16 hex of \`sha256(text)\` + \`"\` | the clock at write time, truncated |

- **A content hash is a natural strong validator.** Two different texts cannot share a tag (within the odds of
  a 64-bit prefix collision), and the same text always gets the same one, so a server restarted from the same
  data hands out the same tags.
- **A version counter is the common alternative.** It is cheaper than hashing a large body and survives
  re-serialisation that changes bytes but not meaning, but it needs to be stored with the row.
- **Dates are coarse.** Two writes in the same second share a \`Last-Modified\`. A client relying on the date
  alone cannot tell them apart, which is why RFC 9110 treats a date as weak unless the server can prove
  otherwise, and why the tag headers outrank the date headers.
- **IMF-fixdate is the one format to send.** Servers must accept two obsolete formats on input, but always
  generate \`Day, DD Mon YYYY HH:MM:SS GMT\`. A date that does not parse at all is ignored, as if the header
  were absent.

:::quiz
Q: A doc is written twice within the same second. A client holds the Last-Modified from the first write and sends If-Unmodified-Since with it. What happens?
- [ ] 412, because the doc changed after the client read it
- [x] The condition passes, because both writes carry the same one-second date, and the second write is silently overwritten unless the client also uses If-Match
- [ ] 428, because a date is not a precondition
> Last-Modified has one-second resolution, so "not modified since 10:00:00" is true for both writes. Only the ETag sees the difference, which is why If-Match takes precedence and why the drill demands it for writes.
:::

# The precedence table

A request may carry all four headers. RFC 9110 §13.2.2 fixes one order so every server answers the same
headers the same way:

| Step | Header | Compared with | Fails when | Then |
| --- | --- | --- | --- | --- |
| 1 | \`If-Match\` | ETag, strong | no listed tag matches (\`*\` matches if the doc exists) | 412 |
| 2 | else \`If-Unmodified-Since\` | Last-Modified | the doc changed after the date | 412 |
| 3 | \`If-None-Match\` | ETag, weak | a listed tag matches (\`*\` if the doc exists) | 304 on GET, else 412 |
| 4 | else \`If-Modified-Since\` (GET only) | Last-Modified | the doc did not change after the date | 304 |
| 5 | | | | perform the method |

\`\`\`text
if If-Match present:            fail -> 412
elif valid If-Unmodified-Since: fail -> 412
if If-None-Match present:       match -> 304 (GET) | 412
elif GET and valid If-Modified-Since: not modified -> 304
perform
\`\`\`

Three things the table says that a hand-rolled version usually gets wrong:

- **"Else" means presence, not outcome.** A request with a stale \`If-None-Match\` and a fresh
  \`If-Modified-Since\` gets the 200: the tag header is present, so the date is never looked at, even though it
  would have said 304.
- **Write conditions come first.** \`If-Match\` failing answers 412 even when \`If-None-Match\` would have produced
  a 304; a client that asked for both wants to know its version is gone.
- **404 comes before all of it.** The drill answers a missing doc on GET and DELETE with 404 before any condition.
  PUT is the exception, because a missing doc is a legitimate target: that is how \`If-None-Match: *\` creates.

:::quiz
Q: GET with If-None-Match: "old" (stale) and If-Modified-Since set to an hour after Last-Modified. What does the server answer?
- [ ] 304, because the date says nothing changed
- [x] 200, because If-None-Match is present, so If-Modified-Since is ignored, and the tag does not match
- [ ] 412, because the tag is stale
> The tag is the more precise validator. When the client sent one, the server must decide on it alone; the date might hide a change made within the same second. A stale tag on a GET is not an error, just a full response.
:::

# Weak versus strong

An ETag starting with \`W/\` is **weak**: the server promises the representations are semantically equivalent,
not byte-identical. Two comparison functions follow (RFC 9110 §8.8.3.2):

| Tag A | Tag B | Strong | Weak |
| --- | --- | --- | --- |
| \`W/"1"\` | \`W/"1"\` | no | yes |
| \`W/"1"\` | \`W/"2"\` | no | no |
| \`W/"1"\` | \`"1"\` | no | yes |
| \`"1"\` | \`"1"\` | yes | yes |

- **Strong:** neither tag is weak and the strings are equal. Used by \`If-Match\`, because a write must replace
  exactly the bytes the writer read.
- **Weak:** equal after dropping \`W/\`. Used by \`If-None-Match\`, because a cache only needs "still good enough
  to show".
- **Lists:** both headers carry comma-separated lists; one match is enough. \`*\` matches any current
  representation and never a missing one.

The consequence the drill checks: \`If-Match: W/"tag"\` fails even when \`"tag"\` is the current ETag, while
\`If-None-Match: W/"tag"\` matches it.

:::details Where weak tags come from
Servers rarely mint weak tags on purpose. A common source is compression: nginx turns a strong ETag into a weak
one when it gzips a response on the fly, because the bytes on the wire no longer match the ones the tag was
computed from. A client that later sends that weak tag in \`If-Match\` gets a 412 it did not expect. This is
correct: the server cannot promise byte-equality for a body it never stored.
:::

:::quiz
Q: Why must If-Match use strong comparison?
- [ ] Because weak tags are deprecated
- [x] Because the condition guards a write: matching a semantically equivalent but different representation could overwrite changes the writer never saw
- [ ] Because If-Match only accepts a single tag
> A weak tag says "equivalent", which is enough for a cache deciding whether to reuse a body. A write needs "identical": anything less lets a concurrent change slip through the precondition.
:::

# 304, 412 and 428

Three status codes, three different messages to the client:

| Status | Meaning | When the drill sends it | Body |
| --- | --- | --- | --- |
| 304 Not Modified | your copy is current, use it | GET whose \`If-None-Match\` matches or \`If-Modified-Since\` passes | none; repeats \`ETag\` and \`Last-Modified\` |
| 412 Precondition Failed | the condition you sent is false | any other failed condition, on any method | \`{"error": "precondition_failed"}\` |
| 428 Precondition Required | send a condition | PUT or DELETE on an existing doc without \`If-Match\` | \`{"error": "precondition_required"}\` |

- **A 304 is a success.** It carries the headers a 200 would have (validators, and in production
  \`Cache-Control\` and \`Vary\`) so the cache can refresh its stored metadata, and it never has a body.
- **A 412 is a refusal that changes nothing.** The method was not performed. The client should fetch the
  current state, reconcile, and retry with the new tag.
- **428 comes from RFC 6585 §3**, not from RFC 9110. Conditions are optional for clients, so a server that wants
  no blind overwrites has to say so. The drill's rule is strict: \`If-Unmodified-Since\` alone, or an
  \`If-None-Match\` that does not match, still gets 428 on an existing doc. Creating a missing doc needs no
  condition, because there is nothing to lose.

:::quiz
Q: A PUT to an existing doc carries only If-None-Match: "zzz", which does not match. What does the drill answer?
- [ ] 200, because the precondition passed
- [ ] 412, because the tag does not match
- [x] 428, because the preconditions passed but a write to an existing doc still needs If-Match
> A non-matching If-None-Match passes step 3, and nothing in steps 1 to 4 fails. The 428 rule sits after the table: it asks for proof that the writer saw the current version, and only If-Match gives that.
:::

# Optimistic concurrency: the lost update

Two editors read the same doc and both save. Without conditions, the second save wins and the first is gone,
and neither editor is told:

:::sequence
{
  "participants": ["Alice", "docs", "Bob"],
  "messages": [
    {"from": "Alice", "to": "docs", "label": "GET /docs/plan", "kind": "sync"},
    {"from": "docs", "to": "Alice", "label": "200 v1 · ETag e1", "kind": "reply"},
    {"from": "Bob", "to": "docs", "label": "GET /docs/plan", "kind": "sync"},
    {"from": "docs", "to": "Bob", "label": "200 v1 · ETag e1", "kind": "reply"},
    {"from": "Alice", "to": "docs", "label": "PUT alice (no condition)", "kind": "sync"},
    {"from": "docs", "to": "Alice", "label": "200", "kind": "reply"},
    {"from": "Bob", "to": "docs", "label": "PUT bob (no condition)", "kind": "sync"},
    {"from": "docs", "to": "Bob", "label": "200 · Alice's edit is lost", "kind": "reply"}
  ]
}
:::

With \`If-Match\` each writer names the version it edited, and the server compares before it writes:

:::sequence
{
  "participants": ["Alice", "docs", "Bob"],
  "messages": [
    {"from": "Alice", "to": "docs", "label": "PUT alice · If-Match e1", "kind": "sync"},
    {"from": "docs", "to": "Alice", "label": "200 · ETag e2", "kind": "reply"},
    {"from": "Bob", "to": "docs", "label": "PUT bob · If-Match e1", "kind": "sync"},
    {"from": "docs", "to": "Bob", "label": "412 Precondition Failed", "kind": "reply"},
    {"from": "Bob", "to": "docs", "label": "re-read, retry · If-Match e2", "kind": "sync"},
    {"from": "docs", "to": "Bob", "label": "200 · ETag e3", "kind": "reply"}
  ]
}
:::

- **Optimistic, not locked.** Nobody holds a lock while editing; conflicts are detected at write time. That
  suits the web, where an editor may keep a tab open for an hour. See
  [optimistic concurrency control](https://en.wikipedia.org/wiki/Optimistic_concurrency_control).
- **The compare and the write must be atomic.** Two PUTs with \`If-Match: e1\` arriving together must not both
  pass the check. In one process a lock around check-and-write is enough; across replicas it becomes a
  compare-and-set in the store, such as \`UPDATE docs SET … WHERE id = ? AND etag = ?\` and a row count of 1.
- **The 428 closes the back door.** Without it, a client that simply omits \`If-Match\` reintroduces the first
  sequence. The W3C's [lost update note](https://www.w3.org/1999/04/Editing/) is the classic statement of the
  problem.
- **DELETE is a write too.** Deleting a doc someone else just changed loses their change just as surely.

:::quiz
Q: Two servers behind a load balancer each check If-Match against their own in-memory copy, then write to a shared database. Is the lost update prevented?
- [ ] Yes, each server checks the tag before it writes
- [x] No, both can pass the check against the same old tag and both write; the comparison has to happen in the shared store, atomically with the write
- [ ] Yes, as long as the clocks agree
> The precondition is only as good as the atomicity of check-then-write. With a shared store, the check must be part of the write (a conditional UPDATE or compare-and-set), or two requests carrying the same tag can both succeed.
:::

# Caches and revalidation

A cache that holds a stale copy does not throw it away; it asks:

:::sequence
{
  "participants": ["Browser cache", "docs"],
  "messages": [
    {"from": "Browser cache", "to": "docs", "label": "GET /docs/readme", "kind": "sync"},
    {"from": "docs", "to": "Browser cache", "label": "200 · ETag e1 · Last-Modified 10:00:00", "kind": "reply"},
    {"from": "Browser cache", "to": "docs", "label": "GET · If-None-Match e1 · If-Modified-Since 10:00:00", "kind": "sync"},
    {"from": "docs", "to": "Browser cache", "label": "304 · ETag e1 · no body", "kind": "reply"}
  ]
}
:::

- **Caches send both validators** when they have both. The server decides on \`If-None-Match\`; the date is a
  fallback for servers that do not do tags.
- **The 304 saves the body, not the round trip.** Freshness (\`Cache-Control: max-age\`) saves the round trip;
  revalidation is what happens once that runs out. [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111) covers
  freshness; the conditions here are the second half.
- **\`If-Modified-Since\` is ignored on anything but GET and HEAD**, so a cache-style header on a PUT does
  nothing. Writers use the \`If-Match\` family.
- **Real systems add** \`Vary\` (one cached copy per encoding or language), \`If-Range\` for resuming downloads,
  and HEAD, which follows the GET rules without a body.

:::quiz
Q: A cache sends If-None-Match: W/"e1" and the doc's current ETag is "e1". What comes back?
- [x] 304, because If-None-Match uses weak comparison and W/"e1" weakly matches "e1"
- [ ] 200, because a weak tag cannot match a strong one
- [ ] 412, because a GET cannot carry a weak tag
> Weak comparison drops W/ from both sides. For a cache, equivalent is enough, so the server confirms its copy with a 304.
:::

# What to take away

- Validators are versions on the wire: an exact \`ETag\` and a one-second \`Last-Modified\`. Tags outrank dates.
- Evaluate in RFC 9110 §13.2.2 order: \`If-Match\`, else \`If-Unmodified-Since\`, then \`If-None-Match\`, else
  \`If-Modified-Since\` on GET. Presence decides which sibling counts, not the outcome.
- \`If-Match\` compares strongly, \`If-None-Match\` weakly; \`W/\` tags never satisfy \`If-Match\`. Unparseable dates
  are ignored.
- 304 means "use your copy", 412 means "your condition is false, nothing happened", 428 means "send a
  condition". Requiring \`If-Match\` on writes is what makes lost updates impossible rather than unlikely.
- The check and the write must be one atomic step in whatever store holds the data.

Primary reference: [RFC 9110 §13, Conditional Requests](https://www.rfc-editor.org/rfc/rfc9110#section-13), with
[RFC 6585 §3](https://www.rfc-editor.org/rfc/rfc6585#section-3) for 428.
`;
