/**
 * The learning guide for News Feed: the concepts the six steps rest on, in the order a reader meets
 * them — push vs pull, capped timelines, batching, idempotent counters — a figure or a demo where one
 * says it faster than prose, a pop quiz per section. Rendered at `/news-feed/learn`; the same Markdown
 * is what the download exports.
 */
export const learn = `# The system at a glance

Open the app and the first screen is the posts of everyone you follow, newest first, in well under a
second — even though you follow a thousand accounts and one of them has fifty million followers.
Twitter's home timeline is the canonical case: reads outnumber writes by orders of magnitude, so the
timeline is **precomputed at write time** into a capped Redis list, with a pull path for the handful of
accounts whose fan-out would be ruinous. The course rebuilds one service, **feed**, and its two workers:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "App", "sub": "POST /posts · GET /feed · like", "x": 8, "y": 50},
    {"id": "api", "kind": "http", "label": "feed-api", "sub": "steps 1, 3–5 · validate, read, hydrate, like", "x": 28, "y": 50},
    {"id": "posts", "kind": "kafka", "label": "posts", "sub": "key = author id", "x": 48, "y": 18},
    {"id": "fanout", "kind": "service", "label": "fanout", "sub": "step 2 · push ids, skip celebrities", "x": 70, "y": 18},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "timeline:{user} · posts:{author} · post:{id}", "x": 90, "y": 50},
    {"id": "postsvc", "kind": "grpc", "label": "PostService", "sub": "step 4 · GetPosts(ids) · 800 ms", "x": 48, "y": 82},
    {"id": "engagement", "kind": "kafka", "label": "engagement", "sub": "key = post id", "x": 70, "y": 82},
    {"id": "rollup", "kind": "service", "label": "engagement-rollup", "sub": "step 6 · dedupe, then count", "x": 90, "y": 82}
  ],
  "edges": [
    {"from": "client", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "api", "to": "posts", "kind": "kafka", "label": "publish"},
    {"from": "posts", "to": "fanout", "kind": "kafka", "label": "consume"},
    {"from": "fanout", "to": "redis", "kind": "redis", "label": "LPUSH · LTRIM"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "LRANGE · MGET · SADD"},
    {"from": "api", "to": "postsvc", "kind": "grpc", "label": "GetPosts"},
    {"from": "api", "to": "engagement", "kind": "kafka", "label": "like events"},
    {"from": "engagement", "to": "rollup", "kind": "kafka", "label": "consume"},
    {"from": "rollup", "to": "redis", "kind": "redis", "label": "HINCRBY"}
  ]
}
:::

- **Post** (step 1): validate, save, publish to the \`posts\` topic, answer \`201\` — in that order.
- **Fan out** (step 2): a consumer pushes the new id into every follower's \`timeline:{user}\` list,
  unless the author is a celebrity.
- **Read** (step 3): one Redis pipeline fetches the pushed ids and the followed celebrities' recent
  posts, merges them by time, returns a page and a cursor.
- **Hydrate** (step 4): ids become posts through one \`MGET\` and one batched gRPC call for the misses.
- **Like** (step 5): a Redis set guards a counter; every like becomes an engagement event.
- **Roll up** (step 6): a consumer dedupes events by id and keeps per-post statistics.

Three ideas run through all six — **push vs pull**, **batching**, **idempotent counters** — and they
are what every feed-shaped system is made of. Ranking, ads, media and the follow graph's own storage
are left out; none of them change the shape.

# Posting: three writes, in an order that matters

\`POST /posts\` is a few lines, but the order of its three effects is the design:

:::sequence
{
  "participants": ["App", "feed-api", "store", "Kafka"],
  "messages": [
    {"from": "App", "to": "feed-api", "label": "POST /posts · X-User-Id: alice · Idempotency-Key: k1 · {text, media_ids}", "kind": "sync"},
    {"from": "feed-api", "to": "feed-api", "label": "validate — text 1–280 chars, ≤ 4 media ids, key present; 400 otherwise, nothing written", "kind": "sync"},
    {"from": "feed-api", "to": "store", "label": "posts.save(post) — SET post:{id} · ZADD posts:alice · idem:alice:k1", "kind": "sync"},
    {"from": "store", "to": "feed-api", "label": "the post — or the earlier post, if k1 was used before", "kind": "reply"},
    {"from": "feed-api", "to": "Kafka", "label": "publish(post) → posts · key = alice", "kind": "async"},
    {"from": "feed-api", "to": "App", "label": "201 {post_id, created_at} · Cache-Control: private, no-store", "kind": "reply"}
  ]
}
:::

- **Validate first.** Body shape, then the header, then the write — ordered by cost. Empty text, more
  than **280** characters, more than **4** media ids, or no \`Idempotency-Key\` → **400**, and
  \`posts.save\` is never reached.
- **Save, then publish.** A record in Kafka for a post that is not in the store would fan out an id
  nobody can hydrate. The reverse failure — saved, never published — is a post only its author's
  \`posts:{author}\` set knows about: invisible, but not broken.
- **Idempotent by key.** A client that retries a timed-out POST reuses its key; the store dedupes on
  \`idem:{author}:{key}\` for 24 hours and answers with the earlier post. The header is the
  [Idempotency-Key draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/).
- **The id carries its time.** \`<created_at ms>-<suffix>\`, so \`created_at(post_id)\` is a string split,
  not a lookup — the timeline sorts and paginates on it without touching Redis.
- **Personal responses are not cacheable.**
  [\`Cache-Control: private, no-store\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control)
  is what stops a shared proxy from serving one user's timeline to the next.
- \`GET /feed?cursor=<ms>&limit=<n>\`: \`limit\` defaults to 20 and must be **1–50** (**400** otherwise);
  the handler passes both through and answers \`{"posts": […], "next_cursor": …}\`.

:::widget idempotency {}

:::quiz
Q: The store write succeeds, then the publish to Kafka throws. What has save-before-publish bought you?
- [x] The post exists and is in the author's own posts:{author} set; no follower's timeline holds an id that cannot be hydrated
- [ ] Nothing — publishing first would have guaranteed the fan-out
- [ ] The post must now be deleted so the two systems agree
> The failure modes are not symmetric. An id in Kafka without a post behind it is pushed into thousands of timelines and hydrates to nothing; a post without a Kafka record is merely not delivered yet, and a republish fixes it. Order the writes so the recoverable failure is the one you can have.
:::

# Push or pull: the fan-out decision

A home timeline can be built when a post is written or when a feed is read. Neither is free; they fail
in opposite places:

| | Fan-out on write (push) | Fan-out on read (pull) |
| --- | --- | --- |
| Work happens | once per post, for every follower | on every page view, for every followed account |
| A post costs | one Redis command pair × followers | nothing |
| A page costs | one \`LRANGE\` | one query per followed account, then a merge |
| Breaks when | an author has millions of followers | a reader follows thousands of accounts |
| A new post appears | after the fan-out lag | immediately |

Feeds read orders of magnitude more often than they write, so push is the default. The one case push
cannot afford is the **celebrity**: fifty million \`LPUSH\`es for one post, and every other author whose
records share the partition waits behind it. The **hybrid**: push for the long tail, pull for the few.

- \`CELEBRITY_FOLLOWERS\` is **10 000**: one comparison on the length of \`graph.followers(author)\`,
  before any Redis call.
- Over the threshold → the worker **skips the fan-out** and commits the offset; skipping is a normal
  outcome. The post is still in \`posts:{author}\`, a sorted set scored by \`created_at\` that
  \`posts.save\` maintains for every author — that is what readers pull from.
- Under it → one \`LPUSH\` per follower (next section).
- The \`posts\` topic is **keyed by author id**, so one author's posts land on one partition in order.
  The worker is a member of consumer group \`fanout\`; add members and the partitions are shared out.

:::widget consumer-groups {"partitions": 8}

:::quiz
Q: Why is the celebrity test on the author's follower count rather than on how many accounts the reader follows?
- [x] The cost that explodes is the write — one post × followers; the pull side is bounded per celebrity by LIMIT and merged in one pipeline
- [ ] Because the reader's following count is unknown at write time
- [ ] Because the follow graph only stores followers, not followings
> Push cost is a product of the author's audience; a reader's following count only decides how many sorted sets the read pipeline queries, each capped at limit. The threshold goes where the multiplication is.
:::

# A timeline is a capped list

The fan-out worker's unit of work is two Redis commands per follower:

\`\`\`text
LPUSH timeline:bob 1700000000123-9f3a    # newest id at the head
LTRIM timeline:bob 0 999                 # keep 1000; the range is inclusive
\`\`\`

- **Capped at** \`TIMELINE_LEN\` **= 1000.** A timeline is a cache of recent ids, not a history; the
  cap bounds memory to a thousand ids per user however long the account lives.
- **Pipelined, 500 followers per batch.** Two commands per follower, one execute per chunk: a
  5 000-follower post is 10 000 commands in **10 round trips** instead of 10 000.
  [Pipelining](https://redis.io/docs/latest/develop/use/pipelining/) matters as much as the threshold.
- **Auto-commit off; commit after the last pipeline.** An offset acknowledged before the pushes happened
  is a post that silently never reaches anyone.
- **Replay is harmless.** A crash halfway re-runs the whole fan-out: \`LPUSH\` of an id already present
  duplicates it, \`LTRIM\` caps the damage, and the read dedupes.

:::details Why a list, and what it cannot do
\`LPUSH\`, \`LTRIM\` and \`LRANGE\` at the head of a list are as cheap as Redis gets — right for "the
newest few dozen ids". What a list cannot do is **seek by time**: positions, not scores. The read works
around it by over-fetching and filtering in code, fine for the first pages and poor for deep ones. Real
feeds keep the timeline as a sorted set scored by \`created_at\` or a time-sortable id such as Twitter's
Snowflake, so the cursor becomes a score bound.
:::

:::quiz
Q: The worker crashes after the third of five pipelines for a 2 300-follower post. What happens on restart?
- [x] The record is redelivered and all five pipelines run again; the first 1 500 followers get the id twice, LTRIM keeps every list at 1000, the read dedupes
- [ ] The post is lost for the last 800 followers
- [ ] Kafka resumes at the fourth pipeline
> Kafka tracks offsets per record, not per pipeline; the uncommitted record comes back whole. The design makes the repeat cheap rather than preventing it: a duplicated id in a capped list is a non-event, an undelivered post is not.
:::

# Reading the hybrid: merge pushed and pulled

A page is the union of two sources that answer the same question — *posts older than the cursor,
newest first* — in different ways:

:::sequence
{
  "participants": ["feed-api", "graph", "Redis"],
  "messages": [
    {"from": "feed-api", "to": "graph", "label": "celebrities_followed(alice)", "kind": "sync"},
    {"from": "graph", "to": "feed-api", "label": "[taylor, nasa]", "kind": "reply"},
    {"from": "feed-api", "to": "Redis", "label": "LRANGE timeline:alice 0 39", "kind": "sync"},
    {"from": "feed-api", "to": "Redis", "label": "ZREVRANGEBYSCORE posts:taylor +inf -inf LIMIT 0 20 · posts:nasa …", "kind": "sync"},
    {"from": "Redis", "to": "feed-api", "label": "3 replies (one pipeline)", "kind": "reply"},
    {"from": "feed-api", "to": "feed-api", "label": "merge · dedupe · sort by created_at desc · [:20] · next_cursor = created_at of the last", "kind": "sync"}
  ]
}
:::

| Source | Key | Command | "older than the cursor" applied by |
| --- | --- | --- | --- |
| pushed | \`timeline:alice\` (list, newest first) | \`LRANGE 0 2*limit-1\` | the code, after the fact: \`created_at(id) < cursor\` |
| pulled | \`posts:taylor\` (sorted set, score = \`created_at\`) | \`ZREVRANGEBYSCORE (cursor -inf LIMIT 0 limit\` | Redis, through the score; \`(\` makes the bound exclusive |

- **Over-fetch the list.** \`2*limit\` entries, because the list cannot apply the cursor and some of
  the head may be newer than it. The sorted sets need no slack; \`+inf\` stands in for a missing cursor.
- **One pipeline.** The \`LRANGE\` first, then one \`ZREVRANGEBYSCORE\` per celebrity, then a single
  execute: the first reply is the pushed list, the rest line up with the celebrity list.
- **Merge in code.** Union the ids, drop duplicates (a replayed fan-out), sort by \`created_at\`
  descending, cut to \`limit\`. The merge hides which source each id came from.
- **The cursor is a timestamp.** \`next_cursor\` is the \`created_at\` of the last post returned, or
  nothing when the page is empty.

One round trip, a handful of replies, a sort of at most a few dozen ids — regardless of how many
followers the celebrities have. Real feeds rank after this candidate step and cache the hydrated first
page per user for a few seconds.

:::quiz
Q: Why fetch 2×limit ids from the list but only limit from each sorted set?
- [x] The list cannot apply the cursor, so the slack leaves room for head entries that are newer than it and get filtered out in code; the sorted set already returned only older ones
- [ ] Lists are cheaper to read, so over-fetching is free
- [ ] To leave room for duplicates coming from the sorted sets
> A sorted set with an exclusive max bound answers the predicate itself; a list answers by position. Over-fetching is the price of a structure that cannot seek — and the reason deep pagination over a list degrades.
:::

# Hydration and the N+1 problem

The timeline answers with twenty ids; the client wants twenty posts. The naive hydrator does twenty
cache reads and then twenty RPCs — the
[N+1 problem](https://stackoverflow.com/questions/97197/what-is-the-n1-selects-problem-in-orm-object-relational-mapping)
in a feed's clothing. The course does one of each:

\`\`\`proto
service PostService {
  rpc GetPosts(GetPostsRequest) returns (GetPostsReply);
}
message GetPostsRequest { repeated string ids = 1; }
message GetPostsReply   { repeated Post posts = 1; }
\`\`\`

:::sequence
{
  "participants": ["feed-api", "Redis", "PostService"],
  "messages": [
    {"from": "feed-api", "to": "Redis", "label": "MGET post:a post:b post:c post:d", "kind": "sync"},
    {"from": "Redis", "to": "feed-api", "label": "[json, nil, json, nil]", "kind": "reply"},
    {"from": "feed-api", "to": "PostService", "label": "GetPosts(ids=[b, d]) · deadline 800 ms", "kind": "sync"},
    {"from": "PostService", "to": "feed-api", "label": "GetPostsReply{posts=[b]} — d was deleted", "kind": "reply"},
    {"from": "feed-api", "to": "Redis", "label": "pipeline: SET post:b <json> EX 3600", "kind": "sync"},
    {"from": "feed-api", "to": "feed-api", "label": "return [a, b, c] in input order", "kind": "sync"}
  ]
}
:::

- **Cache first, in one command.** \`MGET post:{id} …\` for every id; the replies line up with the ids.
  Posts are **immutable once published**, so a hit is always correct and there is nothing to invalidate.
- **One RPC for the misses, with a deadline.** \`GetPosts\` with the list of ids that were \`nil\` —
  never one call per id — and **800 ms** on the call. If nothing missed, no call at all. A post service
  slower than the deadline surfaces \`DEADLINE_EXCEEDED\` rather than holding the page open.
- **Write back in one pipeline.** \`SET post:{id} <json> EX 3600\` for every fetched post: the cache
  fills itself from the long tail of pages, and the TTL bounds memory for posts nobody asks for again.
- **A deleted post is absent, not an error.** It is simply not in the reply; the hydrator skips it.
- **Input order wins.** The answer is a walk over the *input* ids, picking from a map and skipping what
  is missing — the timeline decided the order, not the cache. One loop gives both the ordering and the
  tolerance for deletions, so a timeline can keep a deleted id for a while without the client seeing a hole.

:::widget cache-aside {}

:::quiz
Q: The cache answers 17 of 20 ids. What does the hydrator send to PostService?
- [x] One GetPosts with the three missing ids and an 800 ms deadline
- [ ] Three unary calls, one per id, in parallel
- [ ] One GetPosts with all 20 ids, to refresh the cache
> Parallel calls still cost N connections' worth of headers, scheduling and tail latency, and the slowest one sets the page's time; one request with a repeated field costs one. Refetching hits throws away the cache's whole point — posts do not change.
:::

# Likes: the set is the fact, the counter follows

A double-tap, a retry after a timeout, or a replayed request must never count twice. \`INCR\` cannot
tell a second request from a first, so the **membership set is the source of truth** and the counter
only moves when the set did:

| Request | Redis | Returns | Then |
| --- | --- | --- | --- |
| \`POST /posts/p1/like\`, first time | \`SADD liked:p1 alice\` | 1 | \`INCR likes:p1\` · \`like\` event · **200** \`{"likes": 42}\` |
| the same, retried | \`SADD liked:p1 alice\` | 0 | **409**, nothing else |
| \`DELETE /posts/p1/like\` | \`SREM liked:p1 alice\` | 1 | \`DECR likes:p1\` · \`unlike\` event · **200** |
| the same, never liked | \`SREM liked:p1 alice\` | 0 | **409** |
| \`GET /posts/p1/likes\`, nobody yet | \`GET likes:p1\` | nil | **200** \`{"likes": 0}\` — not an error |

\`SADD\` and \`SREM\` return how many members actually changed; that integer *is* the idempotency check,
and the branch on it comes before the counter is touched. The event that follows a successful like:

\`\`\`json
{"event_id": "…", "type": "like", "post_id": "p1", "user_id": "alice", "ts": 1700000000123}
\`\`\`

- **Keyed by the post id**, so one post's likes and unlikes stay in order on one partition — an
  \`unlike\` can never overtake the \`like\` it undoes.
- **Fire and forget.** The request never waits for the broker; the producer retries on its own.
- **Carries an** \`event_id\`, because retries and replays mean the consumer *will* see it twice.

:::widget kafka-partitions {"partitions": 8}

The honest gap: \`SADD\` and \`INCR\` are two commands, and a crash between them leaves the set one
ahead of the counter. Real systems make the pair atomic (a Lua script or \`MULTI\`), shard the sets of
viral posts, and eventually move the counter to the rollup stream so the request path writes only the fact.

:::quiz
Q: A user double-taps and both requests reach the server. Why can the counter not be the source of truth?
- [x] INCR cannot tell a second request from a first; SADD returns 0 for a member already present, and only that answer gates the counter
- [ ] Because INCR is slower than SADD
- [ ] Because a counter cannot be decremented
> The set records the fact "alice likes p1"; the counter is a number derived from it. Any design where the counter moves before the fact is checked counts the retry.
:::

# Rolling up at-least-once events without counting twice

The rollup consumer keeps \`stats:{post}\` — a hash with \`likes\`, \`comments\`, \`shares\` — from the
\`engagement\` stream. It commits after processing, so delivery is
[at-least-once](https://kafka.apache.org/documentation/#semantics): the producer retries, a crash here
replays records, and duplicates **will** arrive. The consumer is made idempotent instead:

:::sequence
{
  "participants": ["Kafka", "engagement-rollup", "Redis"],
  "messages": [
    {"from": "Kafka", "to": "engagement-rollup", "label": "poll → {like, p1, event_id e7} (offset 318)", "kind": "reply"},
    {"from": "engagement-rollup", "to": "Redis", "label": "SET seen:e7 1 NX EX 604800 → OK: first sight", "kind": "sync"},
    {"from": "engagement-rollup", "to": "Redis", "label": "HINCRBY stats:p1 likes 1 → 42", "kind": "sync"},
    {"from": "engagement-rollup", "to": "Kafka", "label": "commit offset 319", "kind": "sync"},
    {"from": "Kafka", "to": "engagement-rollup", "label": "poll → {like, p1, event_id e7} again (replay)", "kind": "reply"},
    {"from": "engagement-rollup", "to": "Redis", "label": "SET seen:e7 1 NX → (nil): already counted, skip", "kind": "sync"},
    {"from": "engagement-rollup", "to": "Kafka", "label": "commit offset 320 — or it is re-read forever", "kind": "sync"}
  ]
}
:::

The claim is one command: \`SET seen:{event_id} 1 NX EX 604800\` answers \`OK\` only when it created the
key. Then the \`FIELDS\` table maps the type to a field and a delta — \`like\` is \`likes +1\`,
\`unlike\` is \`likes -1\`, \`comment\` and \`share\` their own fields — and \`HINCRBY\` applies it; a
negative delta is how an unlike undoes a like.

Every exit from the loop body commits, except one:

| Record | Redis | Commit the offset? |
| --- | --- | --- |
| malformed, or an unknown type | nothing | yes — log it; a crash loop helps nobody |
| duplicate (\`SET NX\` → nil) | nothing | yes — it was counted already |
| new (\`SET NX\` → OK) | \`HINCRBY\` | yes, afterwards |
| Redis unreachable | — | **no** — the record is redelivered |

:::widget delivery-semantics {}

- **A week's TTL** on the claim: duplicates come from retries and replays, which happen within minutes,
  not months. A \`SET NX\` that never expired would be a second copy of the whole event stream.
- **The one real gap** is between the claim and the \`HINCRBY\`: a crash there loses the event's
  count, because the replay finds the key already set. Real rollups close it with one Lua script for
  both, batch commits per poll, and bucket the counters per minute so "likes in the last hour" is a
  range read.

At-least-once delivery plus a consumer whose repeat is a no-op: that is how streams get effectively-once
*results* without transactions.

:::quiz
Q: A replayed record arrives and SET NX answers nil. Should the consumer commit its offset?
- [x] Yes — the event was counted the first time; leaving the offset uncommitted re-reads it on every restart
- [ ] No — only records that changed a counter are committed
- [ ] Only once the seen key's TTL has expired
> Committing says "I am done with this record", not "this record changed something". A duplicate is done the moment the claim fails; the only record that must come back is one the consumer could not finish because Redis was away.
:::

# What to take away

- **Order the writes by their failure mode.** Validate, save, publish, \`201\`: a rejected request
  costs nothing, and Kafka never carries an id the store does not have.
- **Push for the many, pull for the few.** Fan-out on write makes a page one \`LRANGE\`; a celebrity
  threshold keeps one post from becoming fifty million writes; the read merges both sources so the
  client cannot tell.
- **Batch every round trip.** Five hundred commands per pipeline, one \`MGET\` for the cache, one
  \`GetPosts\` for the misses with a deadline — never N calls where one will do.
- **Record the fact, derive the number.** \`SADD\` returns 0 for a retry; the counter only moves when
  the set did.
- **At-least-once plus an idempotent consumer.** A \`SET NX\` claim per event id, with a TTL; commit on
  every exit except the one where Redis was away.

The primary source is Raffi Krikorian's
[*Timelines at Scale*](https://www.infoq.com/presentations/Twitter-Timeline-Scalability/) (QCon San
Francisco, 2012): forty minutes on how Twitter's home timeline is precomputed into Redis at write time,
why reads and writes are sized so differently, and what happens when one account has tens of millions
of followers.
`;
