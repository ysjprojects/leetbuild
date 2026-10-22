/**
 * The learning guide for Feature Gates: the concepts the four steps rest on, in the order a reader
 * meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/dropbox-gates/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

Dropbox's **Stormcrow** decides, for every user and every feature, which variant they see — on web,
desktop and mobile — from configuration an operator edits at any hour. The course rebuilds its four
pieces:

:::diagram
{
  "nodes": [
    {"id": "dropboxer", "kind": "client", "label": "Dropboxer", "sub": "PUT /gates/{name} · history", "x": 8, "y": 26},
    {"id": "api", "kind": "http", "label": "gates API", "sub": "step 1 · validate, version, remember", "x": 30, "y": 26},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "gates · gates:version · history", "x": 56, "y": 26},
    {"id": "clients", "kind": "client", "label": "Desktop · mobile", "sub": "GetVariants at start-up", "x": 8, "y": 74},
    {"id": "svc", "kind": "grpc", "label": "Gates", "sub": "step 3 · one batch reply", "x": 30, "y": 74},
    {"id": "web", "kind": "service", "label": "app servers", "sub": "step 2 · snapshot + get_variant", "x": 56, "y": 74},
    {"id": "kafka", "kind": "kafka", "label": "gate-exposures", "sub": "step 4 · key = gate", "x": 79, "y": 74},
    {"id": "monitoring", "kind": "service", "label": "monitoring", "sub": "per-variant graphs", "x": 94, "y": 74}
  ],
  "edges": [
    {"from": "dropboxer", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "HSET · INCR · LPUSH"},
    {"from": "web", "to": "redis", "kind": "redis", "label": "GET version · HGETALL"},
    {"from": "clients", "to": "svc", "kind": "grpc", "label": "GetVariants"},
    {"from": "svc", "to": "web", "kind": "plain", "label": "snapshot"},
    {"from": "web", "to": "kafka", "kind": "kafka", "label": "exposures"},
    {"from": "kafka", "to": "monitoring", "kind": "kafka", "label": "consume"}
  ]
}
:::

- **Edit** (step 1): an HTTPS API validates a gate, versions it, remembers who changed it.
- **Decide** (step 2): every app server holds a snapshot of all gates and assigns variants by hashing —
  no network call per decision.
- **Serve the clients** (step 3): desktop and mobile ask once, over gRPC, for every gate they need.
- **Log** (step 4): every exposure goes to Kafka without the request waiting for it.

# Why a gate is not an if-statement

A deploy puts code on servers; a release lets users see it. A **feature gate** — a
[feature toggle](https://martinfowler.com/articles/feature-toggles.html), in the literature's name —
separates the two: the code ships with the check in it, and the answer is configuration.

\`\`\`python
if get_variant("button_color", user) == "RED_BUTTON":
    render_red()
\`\`\`

One mechanism, four jobs:

| Job | The gate | Who flips it |
| --- | --- | --- |
| Kill switch | \`ON\` → \`OFF\` in seconds when a code path misbehaves | the on-call engineer |
| Canary | 1% → 10% → 100%, each step a config edit | the team shipping the feature |
| A/B test | \`50 / 50\`, per-variant graphs compared | product and data |
| Private beta | a population matched by team or domain | product |

Stormcrow's edits
[reach production within ten minutes](https://dropbox.tech/infrastructure/introducing-stormcrow);
nothing is rebuilt.

:::quiz
Q: A team wants the new sidebar at 10% this week and 100% next week. Why a gate rather than a hard-coded percentage in a branch?
- [ ] A gate is faster to evaluate than an if-statement
- [x] Moving from 10% to 100% — or back to 0% at 3 a.m. — must not need a deploy
- [ ] Branches cannot read the current user
> The decision is the same if-statement either way; what the gate changes is who can flip it, and how fast. A rollback that needs a build and a deploy is a rollback measured in hours.
:::

# Anatomy of a gate

Red button for a third of German-speaking users, nothing for anyone else, and one Dropboxer pinned in
to look at it:

\`\`\`json
{
  "seed": "button_color",
  "default": "OFF",
  "populations": [
    {"match": {"locale": "de"}, "mix": [{"variant": "RED_BUTTON", "pct": 33}, {"variant": "OFF", "pct": 67}]}
  ],
  "overrides": [{"user_id": "tomm", "variant": "RED_BUTTON", "expires_at": 1700003600}]
}
\`\`\`

- **populations** — tried **in order**, the first match decides (fall-through, like firewall rules).
  \`match\` is attribute equalities that must all hold; \`{}\` matches everyone, so it goes last.
- **mix** — the population's variant shares; they add up to exactly 100. \`33 + 67\` is a rollout,
  \`50 + 50\` an experiment, \`100\` a switch.
- **default** — the answer when no population matches. An unknown gate answers \`OFF\`, so code can
  ship with the check before the gate exists.
- **seed** — feeds the assignment hash (next section); defaults to the name. Two gates with one seed
  assign the same users the same way.
- **overrides** — pin a user into a variant until \`expires_at\`. For QA; they expire on their own.

Three users, this gate, evaluated in order — override, then populations, then default:

| User | Attributes | Override? | Population | Answer |
| --- | --- | --- | --- | --- |
| Ana | \`locale: de\` | no | first (\`locale: de\`) | her bucket decides: \`RED_BUTTON\` or \`OFF\` |
| Ben | \`locale: en\` | no | none | \`OFF\` (the default) |
| Tom | \`locale: en\` | yes, until \`expires_at\` | — | \`RED_BUTTON\`; after it expires, \`OFF\` like Ben |

:::quiz
Q: An editor submits a mix of \`{"RED_BUTTON": 40, "OFF": 30}\`. What should the API do?
- [ ] Accept it; the missing 30% falls through to the default
- [x] Reject it with 400 and write nothing
- [ ] Scale the shares up to 100 and store that
> Shares partition the bucket space; a mix adding up to 70 silently assigns nobody to its last 30%, and nobody can tell from the graphs whether that was intended. Half-valid configuration is the most expensive kind, so the API refuses it before anything is written.
:::

# Assignment is a hash, not a record

The obvious design stores each user's variant on first sight. Then a hundred servers must agree, a new
server must learn every assignment before it can serve, and the store sits on every request. Stormcrow
stores **nothing** — the variant is a function of the user and the gate:

\`\`\`text
bucket  = int(sha256("{seed}:{user_id}")[:8], 16) % 10000
variant = the first share whose cumulative edge is above the bucket, walking the mix in order
\`\`\`

A share of \`pct\` owns the next \`pct × 100\` buckets. For the mix above:

| Share | Owns buckets | Cumulative edge |
| --- | --- | --- |
| \`RED_BUTTON\` 33 | 0 – 3299 | 3300 |
| \`OFF\` 67 | 3300 – 9999 | 10000 |

Ana hashes to bucket \`4123\`: past the first edge, so \`OFF\`. Four properties follow, and the whole
system leans on them:

- **Stateless** — nothing is written when a user is assigned; a decision costs one hash.
- **Consistent** — every server, in every language, computes the same answer; a server that boots
  today agrees with one that has run for a month.
- **Monotone rollouts** — raising a share from 10 to 20 moves its edge from \`1000\` to \`2000\`: the
  first thousand buckets keep their variant, the next thousand join, nobody is reshuffled. That is why
  the mix is ordered, and why *reordering* it is a reshuffle.
- **Correlated when you want it** — two gates with one seed put a user in the same bucket, so a
  migration gated in two places still agrees.

\`sha256\` rather than a fast non-cryptographic hash for one reason: it is in every language's
standard library, so a Python server, a Go service and a C++ client agree on the bucket.

:::widget percent-rollout {}

:::quiz
Q: A gate is at 10% and the team raises it to 20%. What happens to the users who were already in?
- [x] They stay in; the edge moves and the next 10% of buckets join them
- [ ] Everyone is reassigned, so about half of them drop out
- [ ] They stay in only if the server keeps a record of them
> With cumulative edges in a fixed order, raising a share only moves its upper edge. The users in buckets 0–999 were in and still are — without any server remembering them.
:::

# No I/O on the decision path

The mistake every first gating system makes: reading configuration from a database **per decision**.
Thirty gates on a page become thirty fetches, and the database becomes a single point of failure for
every request. Stormcrow pushes a \`stormcrow_config.json\` to every server instead; the course uses one
Redis hash and a version counter the **loader** polls:

:::sequence
{
  "participants": ["request", "app server", "loader", "Redis"],
  "messages": [
    {"from": "loader", "to": "Redis", "label": "GET gates:version (every 10 s)", "kind": "sync"},
    {"from": "Redis", "to": "loader", "label": "\\"7\\" — was 6", "kind": "reply"},
    {"from": "loader", "to": "Redis", "label": "HGETALL gates", "kind": "sync"},
    {"from": "Redis", "to": "loader", "label": "{button_color: {…}, …}", "kind": "reply"},
    {"from": "loader", "to": "app server", "label": "snapshot = v7, swapped in one assignment", "kind": "async"},
    {"from": "request", "to": "app server", "label": "get_variant(\\"button_color\\", ana)", "kind": "sync"},
    {"from": "app server", "to": "request", "label": "OFF — sha256 → bucket 4123; no I/O", "kind": "reply"},
    {"from": "loader", "to": "Redis", "label": "GET gates:version (10 s later)", "kind": "sync"},
    {"from": "Redis", "to": "loader", "label": "\\"7\\" — unchanged, no HGETALL", "kind": "reply"}
  ]
}
:::

- **Unchanged version → stop.** One cheap \`GET\` per poll for the whole fleet.
- **Changed →** \`HGETALL\`, parse every gate, replace the snapshot in a **single assignment**: a request
  never reads half a reload.
- \`get_variant\` **reads the snapshot and nothing else.** Unknown gate → \`OFF\`; unexpired override
  wins; otherwise the first matching population and the hash decide.

The accounting for 200 servers: Redis sees 20 \`GET\`s a second plus one \`HGETALL\` per server per edit.
A page evaluating thirty gates costs it nothing. If Redis is away for a minute, the loader logs an
error and the snapshot it has keeps answering — the price is staleness, not errors.

:::quiz
Q: Redis is unreachable for a minute. What does a request that evaluates thirty gates pay?
- [x] Nothing: it reads the snapshot the loader already holds
- [ ] Thirty timeouts, one per gate
- [ ] One timeout, then the gate defaults
> Only the loader talks to Redis, and it already did. An edit made during that minute lands a minute late; no request is slower or wrong.
:::

# The editing API: the hard part is around the write

\`PUT /gates/{name}\` is a few lines of storage and a lot of semantics — the semantics are what let a
team operate it at 3 a.m.:

:::sequence
{
  "participants": ["Dropboxer", "gates API", "Redis"],
  "messages": [
    {"from": "Dropboxer", "to": "gates API", "label": "PUT /gates/button_color · If-Match: \\"2\\" · X-Editor: tomm", "kind": "sync"},
    {"from": "gates API", "to": "gates API", "label": "validate — shares add up to 100, names well-formed; 400 and nothing written otherwise", "kind": "sync"},
    {"from": "gates API", "to": "Redis", "label": "HGET gates button_color", "kind": "sync"},
    {"from": "Redis", "to": "gates API", "label": "{…, \\"version\\": 2} — If-Match holds (412 otherwise)", "kind": "reply"},
    {"from": "gates API", "to": "Redis", "label": "MULTI · HSET gates button_color {…v3} · INCR gates:version · LPUSH history · LTRIM 0 99 · EXEC", "kind": "sync"},
    {"from": "Redis", "to": "gates API", "label": "OK", "kind": "reply"},
    {"from": "gates API", "to": "Dropboxer", "label": "200 {…, \\"version\\": 3} · ETag: \\"3\\"", "kind": "reply"}
  ]
}
:::

- **Validate, then write — never half.** Name, populations, every match, every mix, every variant
  name; a rejected request answers **400** with a reason and leaves no trace.
- **Attribution.** \`X-Editor\` is required (**400** without it): gate edits are not in version control
  and happen at any hour.
- **Versions.** A new gate is version 1 (**201**); an update bumps it (**200**); both answer
  \`ETag: "<version>"\`.
- **Optimistic concurrency.** \`If-Match\` with a version that is no longer current → **412**, nothing
  written — HTTP's native form of
  [optimistic concurrency control](https://en.wikipedia.org/wiki/Optimistic_concurrency_control).
- **History.** \`{version, at, by, change}\` pushed onto \`gate:{name}:history\`, newest first, last 100
  kept: the audit trail, and the annotations on the graphs.
- **One transaction.** \`HSET\`, \`INCR gates:version\`, \`LPUSH\`/\`LTRIM\` in one \`MULTI\`/\`EXEC\`, so a loader
  never sees the new gate without the version bump that tells it to reload.

:::widget status-codes {}

:::details Why PUT, and why ETag / If-Match rather than a version in the body
\`PUT\` replaces the whole resource and is idempotent: the same gate sent twice stores the same gate
(the version bumps — the honest answer, and the history records that you did it twice). The
[\`ETag\` / \`If-Match\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Match) pair is HTTP's
own optimistic-concurrency protocol: \`GET\` returns an \`ETag\`, the editor sends it back as \`If-Match\`,
and the server answers \`412 Precondition Failed\` if the resource moved on. Browsers, proxies and
HTTP clients all understand it; a \`version\` field in the body is the common substitute when the
client library cannot set headers.
:::

:::quiz
Q: Two Dropboxers open the same gate at version 2. The first saves. The second saves with \`If-Match: "2"\`. What should the second get?
- [ ] 200 — last write wins, that is what PUT means
- [x] 412 with the current version, and the stored gate is unchanged
- [ ] 409 and the two gates merged
> The first save made it version 3; the second request's precondition names version 2 and fails. The second editor re-reads, sees the colleague's change, and decides — instead of finding the overwrite in the history a week later.
:::

# One batch call for the clients

A web server holds the snapshot; a desktop or mobile build cannot, because the configuration changes
after the app shipped. So clients ask **once, at start-up**, for every gate they care about — one
unary gRPC call instead of one per decision:

:::sequence
{
  "participants": ["Desktop app", "Gates", "snapshot"],
  "messages": [
    {"from": "Desktop app", "to": "Gates", "label": "GetVariants(user_id: ana, attrs: {platform: mac, locale: de}, features: [button_color, dark_mode, new_sidebar])", "kind": "sync"},
    {"from": "Gates", "to": "snapshot", "label": "get_variant × 3 — in memory, no Redis", "kind": "sync"},
    {"from": "snapshot", "to": "Gates", "label": "OFF · ON · OFF (new_sidebar: unknown gate)", "kind": "reply"},
    {"from": "Gates", "to": "Desktop app", "label": "{variants: {button_color: OFF, dark_mode: ON, new_sidebar: OFF}, version: 7}", "kind": "reply"}
  ]
}
:::

- The client sends **what it knows** — platform, app version, locale — in \`attrs\`; the service does
  no lookups of its own. *Avoid I/O in the gating system*, applied to the clients.
- One variant per requested feature, from the same \`get_variant\` over the same snapshot. An unknown
  gate answers \`OFF\`, **not an error**: a newer build asking about an unpublished gate must still start.
- An empty \`features\` list means every gate in the snapshot.
- The reply carries the snapshot's **version**: the client, and the engineer reading its logs, can say
  which edit produced the behaviour.
- The only error: \`INVALID_ARGUMENT\` for an empty \`user_id\`.
- The handler reads the snapshot **once**, at the top, so every variant in one reply comes from the
  version it reports — even if the loader swaps the snapshot mid-call.

:::widget grpc-streams {"mode": "unary"}

:::quiz
Q: A desktop build asks for \`new_sidebar\`, a gate that does not exist yet. Why answer \`OFF\` rather than an error?
- [x] So client releases and gate publishing are independent: the app ships with the check, the gate comes later
- [ ] Because gRPC has no status code for a missing key
- [ ] Because the snapshot might be stale
> The check is in the code before the gate exists and after it is deleted. Treating both as "off" is what lets a team ship the app on Monday and create the gate on Thursday.
:::

# Exposures: logged, never awaited

Every assignment is logged, and the per-variant graphs — the whole point of an A/B test — are drawn
from that stream. \`get_exposed_variant\` decides with \`get_variant\`, then produces one **exposure event**
to \`gate-exposures\` — and returns before the broker answers:

:::sequence
{
  "participants": ["app server", "exposures", "Kafka"],
  "messages": [
    {"from": "app server", "to": "exposures", "label": "get_exposed_variant(\\"button_color\\", ana)", "kind": "sync"},
    {"from": "exposures", "to": "exposures", "label": "get_variant → OFF, snapshot v7; in flight 41 of MAX_PENDING 1000", "kind": "sync"},
    {"from": "exposures", "to": "Kafka", "label": "produce gate-exposures · key = button_color · {feature, variant, version: 7, user_id, ts}", "kind": "async"},
    {"from": "exposures", "to": "app server", "label": "OFF — before the broker answers", "kind": "reply"},
    {"from": "Kafka", "to": "exposures", "label": "ack, later; a failure is logged, not raised; the slot is freed", "kind": "async"}
  ]
}
:::

Three rules make a log safe to put inside every request:

1. **Fire and forget.** Hand the record to the producer, return the variant. A slow or absent broker
   must not slow a page; a failed delivery is logged, not raised.
2. **Bounded.** At most \`MAX_PENDING\` (1000) exposures in flight. Past that: drop, count in \`dropped\`,
   log one line. Memory is not an unbounded queue for a broker that is not answering.
3. **Flushed with a deadline.** \`shutdown()\` waits up to five seconds for what is pending, then reports
   the rest as dropped. A stopping server must not hang on a dead broker.

Keyed by the **gate name**, so one gate's exposures land on one partition in order; stamped with the
snapshot **version** that made the assignment, so the graphs can be annotated per edit.

:::widget kafka-partitions {"partitions": 8}

A deliberate [**at-most-once**](https://kafka.apache.org/documentation/#semantics) choice: a dropped
exposure is a missing graph point, a blocked request is an outage. Real systems sample the most
common gates, dedupe to one exposure per user per session, and batch the sends — same shape: the
decision is a pure function; the log of it is best-effort by design.

:::widget delivery-semantics {}

:::quiz
Q: The Kafka brokers are away for ten minutes. What must be true of the app servers during that time?
- [ ] Requests wait until the broker is back, so no exposure is lost
- [x] Requests answer at normal latency; exposures beyond the in-flight bound are dropped and counted
- [ ] get_variant answers the default until the broker is back
> The gate decision never depended on Kafka and must not start to during an outage. Dropped and counted is the honest outcome; a growing in-memory queue would only turn a broker outage into an app-server outage later.
:::

# What to take away

- **Separate deploy from release.** The code ships with the check in it; \`OFF\` is the answer for a
  gate that does not exist yet.
- **Assign by hashing, store nothing.** \`sha256(seed:user) % 10000\` against cumulative edges in a
  fixed order: stateless, consistent, monotone, on every server and in every language.
- **Keep I/O off the decision path.** A loader pays for configuration once per change; a request pays
  for nothing it does not already hold. An outage of the config store is staleness, not errors.
- **The admin API's job is semantics.** Validate before writing, attribute every edit, version with
  \`ETag\`/\`If-Match\`, keep history, write atomically.
- **Observability must not become a dependency.** Produce without waiting, bound what is in flight,
  drop and count under pressure, flush with a deadline.

The primary source is Dropbox's
[*Introducing Stormcrow*](https://dropbox.tech/infrastructure/introducing-stormcrow) (Tom McLaughlin,
2017): ten minutes of reading, in the team's own words, on why the configuration is pushed rather than
queried and what the audit history and overrides were for.
`;
