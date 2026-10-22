/**
 * The learning guide for Live Chat Fan-out: the concepts the five steps rest on, in the order a
 * reader meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/live-chat/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

A chat room is one message in, N copies out — where the N members are spread over several server
instances, every one of them wants to know who else is online, and a newcomer wants to see what was
said before they arrived. Slack does it with stateful channel servers and gateway servers holding
millions of long-lived connections; the course rebuilds the five pieces every live fan-out system is
made of, as a few instances of one service, **chat-server**, behind a load balancer:

:::diagram
{
  "nodes": [
    {"id": "client-a", "kind": "client", "label": "Client A", "sub": "ana · room-7 · stream on A", "x": 9, "y": 16},
    {"id": "client-b", "kind": "client", "label": "Client B", "sub": "bo · room-7 · stream on B", "x": 9, "y": 84},
    {"id": "server-a", "kind": "grpc", "label": "chat-server A", "sub": "step 2 · Chat(stream) :9000", "x": 31, "y": 50},
    {"id": "server-b", "kind": "service", "label": "chat-server B", "sub": "step 3 · group chat-server-b-…", "x": 31, "y": 84},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "steps 1, 5 · presence:{user} · recent:{room}", "x": 55, "y": 30},
    {"id": "kafka", "kind": "kafka", "label": "chat-messages", "sub": "step 3 · key = room id", "x": 55, "y": 60},
    {"id": "history", "kind": "http", "label": "history API", "sub": "step 4 · GET /rooms/{room}/messages", "x": 79, "y": 16},
    {"id": "store", "kind": "db", "label": "message store", "sub": "given · newest-first pages", "x": 79, "y": 84}
  ],
  "edges": [
    {"from": "client-a", "to": "server-a", "kind": "grpc", "label": "Chat stream"},
    {"from": "client-b", "to": "server-b", "kind": "grpc", "label": "Chat stream"},
    {"from": "server-a", "to": "redis", "kind": "redis", "label": "SET EX · SADD · LPUSH"},
    {"from": "server-a", "to": "kafka", "kind": "kafka", "label": "produce · consume"},
    {"from": "kafka", "to": "server-b", "kind": "kafka", "label": "consume (own group)"},
    {"from": "client-a", "to": "history", "kind": "http", "label": "GET /rooms/{room}/messages"},
    {"from": "history", "to": "store", "kind": "plain", "label": "list(room, before, limit)"}
  ]
}
:::

- **Presence** (step 1): a heartbeat key per user with a 30 s TTL, a member set per room, one batched
  lookup for who is online.
- **Stream** (step 2): one gRPC bidirectional stream per client — join a room, say things, receive what
  others say, clean up when the client hangs up.
- **Fan-out** (step 3): every message goes through the \`chat-messages\` topic, and every instance
  consumes the whole topic in its *own* consumer group so it can deliver to the streams it holds.
- **History** (step 4): a paginated HTTPS endpoint over the message store, with a short private cache.
- **Recent** (step 5): a capped Redis list that seeds a joining client before live messages flow.

# Presence is a lease, not a record

"Who is online?" is a liveness question. The obvious answer — a status flag flipped on connect and on
disconnect — is wrong the first time a laptop lid closes: nobody runs the disconnect. Expiring keys
answer it without anyone noticing the crash:

| Call | Redis | Why |
| --- | --- | --- |
| \`heartbeat(user, server)\` | \`SET presence:{user} <server> EX 30\` | every 10 s while the stream is open; the same \`SET\` with the same \`EX\` restarts the clock |
| \`join_room(room, user)\` | \`SADD room:{room}:members\` | who *belongs* to the room |
| \`leave(room, user)\` | \`SREM\` the set · \`DEL presence:{user}\` | an explicit leave shows now, not 30 s later |
| \`online_members(room)\` | \`SMEMBERS\`, then **one** \`MGET\` | belongs ∩ alive, in two round trips |

:::sequence
{
  "participants": ["Client", "chat-server", "Redis"],
  "messages": [
    {"from": "Client", "to": "chat-server", "label": "join room-7 as ana", "kind": "sync"},
    {"from": "chat-server", "to": "Redis", "label": "SADD room:room-7:members ana", "kind": "sync"},
    {"from": "Client", "to": "chat-server", "label": "heartbeat (every 10 s)", "kind": "async"},
    {"from": "chat-server", "to": "Redis", "label": "SET presence:ana srv-a EX 30", "kind": "sync"},
    {"from": "chat-server", "to": "Redis", "label": "SMEMBERS room:room-7:members", "kind": "sync"},
    {"from": "Redis", "to": "chat-server", "label": "[ana, bo, cy]", "kind": "reply"},
    {"from": "chat-server", "to": "Redis", "label": "MGET presence:ana presence:bo presence:cy", "kind": "sync"},
    {"from": "Redis", "to": "chat-server", "label": "[srv-a, nil, srv-b]", "kind": "reply"},
    {"from": "chat-server", "to": "Client", "label": "online: ana, cy (bo is away)", "kind": "reply"}
  ]
}
:::

- **Two keys on purpose.** The set says who belongs and outlives the connection; the presence key
  says who is alive and dies with it. Online members is the intersection.
- **The TTL is not a cache expiry.** Nothing is stale: the key *is* the fact, and "key exists" means
  "seen in the last 30 s". Expiry is the crash detector — no health checker, no reaper job. Redis
  calls this a [volatile key](https://redis.io/docs/latest/commands/expire/); distributed systems call
  it a *lease*.
- **30 s is three missed beats.** Shorter, and a GC pause or a flaky network marks people offline
  for nothing; longer, and a crashed user haunts the list.
- **The value is the server.** \`srv-a\` says which instance holds Ana's stream — the hook a later
  direct-message feature routes on.
- **One batched lookup.** \`MGET\` is the part that scales: a 500-member room costs one round trip per member list, not
  500; a \`nil\` in the answer is an offline member.

:::quiz
Q: Bo's laptop lid closes mid-conversation. How does the member list learn he is gone?
- [ ] The server sees the TCP connection close and deletes his presence key
- [x] His client stops heartbeating and \`presence:bo\` expires within 30 s
- [ ] A reaper job scans the room sets and removes members with no recent activity
> A closed lid often sends nothing at all; the server may hold a dead connection for minutes. The lease needs no notice: the absence of renewals is the signal, and Redis does the deleting.
:::

# One bidirectional stream per client

A chat session is two independent flows that happen to share a connection — what the client says and
what the room says — and a gRPC
[bidirectional stream](https://grpc.io/docs/what-is-grpc/core-concepts/#bidirectional-streaming-rpc)
is exactly that: two half-duplex streams over one HTTP/2 stream.

\`\`\`proto
service Chat {
  rpc Chat(stream ClientMsg) returns (stream ServerMsg);
}
message Join      { string room = 1; string user = 2; }
message Say       { string text = 1; }
message ClientMsg { oneof kind { Join join = 1; Say say = 2; } }
message ServerMsg { string room = 1; string user = 2; string text = 3; int64 ts = 4; }
\`\`\`

:::sequence
{
  "participants": ["Client", "chat-server", "room bus"],
  "messages": [
    {"from": "Client", "to": "chat-server", "label": "ClientMsg{join: room-7, ana}", "kind": "sync"},
    {"from": "chat-server", "to": "room bus", "label": "subscribe(room-7) · cleanup registered on the call", "kind": "sync"},
    {"from": "Client", "to": "chat-server", "label": "ClientMsg{say: \\"hi\\"}", "kind": "async"},
    {"from": "chat-server", "to": "room bus", "label": "publish(room-7, ServerMsg{ana, \\"hi\\", ts})", "kind": "async"},
    {"from": "room bus", "to": "chat-server", "label": "ServerMsg{bo, \\"hello ana\\"}", "kind": "async"},
    {"from": "chat-server", "to": "Client", "label": "ServerMsg{bo, \\"hello ana\\"}", "kind": "async"},
    {"from": "Client", "to": "chat-server", "label": "cancel → unsubscribe(room-7)", "kind": "async"}
  ]
}
:::

- **Join first.** The handler reads exactly one message before doing anything else. A \`join\` turns a
  stateless RPC into a session with a validated first message; anything else ends the call with
  \`INVALID_ARGUMENT\` — and there is nothing to clean up, because nothing has been acquired yet.
- **Two loops.** A message from the bus can arrive while the handler is blocked waiting for the
  client's next \`say\`, so forwarding runs on its own task, goroutine, callback or thread: take from
  the subscription, write to the stream, repeat.
- **Nothing is written back directly.** Every \`say\` becomes a \`ServerMsg{room, user, text, ts}\`
  handed to \`publish\`; the sender's own line reaches them through the bus like everyone else's. One
  path, one order, no special case for "echo".
- **Cleanup is registered when the subscription is taken**, through the call's cancellation hook
  (\`add_done_callback\` / \`ctx.Done()\` / \`setOnCancelHandler\`), not at the end of the handler: on a
  cancellation the end of the handler may never run. A stream that keeps its subscription after the
  client is gone leaks one per disconnect — and at chat scale disconnects are the common case.

:::widget grpc-streams {"mode": "bidi"}

:::details What real chat gateways add to the stream
Flow control: when a slow client cannot keep up with a busy room, the gateway drops or coalesces
rather than buffering without bound. Keep-alive pings, so a half-open connection is noticed in
seconds. And resume tokens: a reconnecting client says "everything since sequence N" instead of
rejoining blind — which is why real messages carry a sequence number, not just a timestamp.
:::

:::quiz
Q: Ana's network drops without her client sending anything. What releases her room subscription?
- [ ] The read loop: the next \`say\` never comes, so it eventually returns an error and the handler ends
- [x] The cancellation hook registered when the subscription was taken
- [ ] A periodic sweep comparing subscriptions with presence keys
> The runtime cancels the call when the transport dies, and the end of the handler may never run normally. The only code guaranteed to run is what was hung on the call's cancellation — so that is where unsubscribe goes, and it is wired the moment the subscription exists.
:::

# Fan-out is a broadcast, not a work queue

Ana's stream is on instance A, Bo's on instance B. A message said on A has to reach B, so something has
to carry messages *between* instances: the **room bus**, built on the \`chat-messages\` topic. The
catch is that a
[consumer group](https://kafka.apache.org/documentation/#intro_consumers) is a work-sharing
primitive — partitions are divided among its members — and fan-out wants the opposite:

| Group id | What each instance reads | Result |
| --- | --- | --- |
| one shared \`chat-server\` | the partitions assigned to it — a share of the rooms | Bo never hears Ana |
| \`chat-server-{hostname}-{uuid or pid}\` | the whole topic, as a group of one | every instance gets every message: a broadcast |

:::sequence
{
  "participants": ["chat-server A", "Kafka", "chat-server B"],
  "messages": [
    {"from": "chat-server A", "to": "Kafka", "label": "produce(chat-messages, key=room-7, ServerMsg) — not awaited by the stream", "kind": "async"},
    {"from": "Kafka", "to": "chat-server A", "label": "poll (group chat-server-a-…) → record", "kind": "reply"},
    {"from": "Kafka", "to": "chat-server B", "label": "poll (group chat-server-b-…) → the same record", "kind": "reply"},
    {"from": "chat-server A", "to": "chat-server A", "label": "local_deliver(room-7, msg) → ana", "kind": "async"},
    {"from": "chat-server B", "to": "chat-server B", "label": "local_deliver(room-7, msg) → bo", "kind": "async"}
  ]
}
:::

- **Key = room id.** One room's messages land on one partition, in order, without ordering the whole
  world. The key is also the route: the consumer calls \`local_deliver(key, msg)\` and never has to look
  inside the message to know where it goes.
- **Produce, serve callbacks, return.** The stream never waits for the broker; the message comes back
  to this instance through its own consumer, which is how the sender sees their own line.
- **The group id is computed once, at start-up**, from something that differs per process: hostname
  plus a UUID or the pid. Two instances on the same host must still differ.
- \`local_deliver(room, msg)\` is the last hop: it hands the message to every stream on *this*
  instance subscribed to the room.

:::widget consumer-groups {"partitions": 6}

Set the widget to two consumers in one group and watch the six partitions split between them: the
shared-group failure mode. The same topic serves both patterns; only the group names differ.

:::quiz
Q: An operator "tidies up" the config so every instance uses the group id \`chat-server\`. What breaks?
- [ ] Nothing: Kafka delivers each record to every member of the group
- [x] Each instance now receives only the rooms hashed to its partitions, so users on other instances hear nothing
- [ ] Messages are duplicated, one copy per instance
> Members of one group share the partitions out; that is what a group is for. With three instances and six partitions each sees two partitions' worth of rooms, and a room whose members sit on two different instances is silently split in half.
:::

# Live delivery is at-most-once, by choice

Two consumer settings decide what a live stream is allowed to lose, and the course picks the lossy
answers deliberately:

| Setting | Chosen | What the alternative would do |
| --- | --- | --- |
| \`auto.offset.reset\` | \`latest\` | \`earliest\` replays yesterday's chat into every live stream on each fresh start |
| offset commit | auto-commit | manual commit after delivery gives at-least-once — and duplicate lines on screen after every rebalance |

- A record polled but not yet delivered when the process dies is **gone from the live path**. That is
  acceptable: history comes from the message store, not from Kafka, and the client's next scroll-up
  or rejoin fills the gap.
- At-least-once would need an id on every message and a dedupe set on every client. For a live feed
  the simpler contract wins: Kafka carries *now*, the store carries the record.

:::widget delivery-semantics {}

Real systems put a sequence number in each message so clients can detect gaps and fetch exactly the
missing range, and move to Redis Pub/Sub when Kafka's per-partition latency is too high.

:::quiz
Q: Instance B was down for ten minutes and restarts. What does a client that connects to it see over the stream?
- [ ] The ten minutes of messages it missed, replayed in order
- [ ] Messages from the moment the old process died, because the committed offset is still there
- [x] Only messages said after B came back; the missed ten minutes are in the store, one history request away
> \`latest\` means a fresh consumer starts at the end of the topic, and the group id is new on every start anyway, so there is no committed offset to resume from. A live stream that replayed history would show every joiner ten minutes of stale chat scrolling past.
:::

# Scrolling up: a cursor, not a page number

Older messages are a plain HTTPS read, not the stream:
\`GET /rooms/{room}/messages?before=<ts>&limit=<n>\` over the provided store, whose \`list(room, before,
limit)\` returns messages with \`ts < before\`, newest first.

:::sequence
{
  "participants": ["Client", "history API", "store"],
  "messages": [
    {"from": "Client", "to": "history API", "label": "GET /rooms/room-7/messages?limit=50", "kind": "sync"},
    {"from": "history API", "to": "history API", "label": "limit within 1–100 (400 otherwise); before defaults to now", "kind": "sync"},
    {"from": "history API", "to": "store", "label": "exists(room-7) — 404 if false", "kind": "sync"},
    {"from": "store", "to": "history API", "label": "true", "kind": "reply"},
    {"from": "history API", "to": "store", "label": "list(room-7, now, 50)", "kind": "sync"},
    {"from": "store", "to": "history API", "label": "50 messages, newest first", "kind": "reply"},
    {"from": "history API", "to": "Client", "label": "200 {messages, next_before: ts of the 50th} · Cache-Control: private, max-age=5", "kind": "reply"},
    {"from": "Client", "to": "history API", "label": "GET …?before=<next_before>&limit=50", "kind": "sync"}
  ]
}
:::

The checks run cheapest first, so a bad request never costs a store round trip:

| Condition | Answer |
| --- | --- |
| \`limit\` not a number, or outside **1–100** (default 50) | **400**, before touching the store |
| \`store.exists(room)\` is false | **404** |
| otherwise | **200** \`{"messages": […], "next_before": <ts>}\` |

- \`next_before\` is the \`ts\` of the **last** message on the page — the oldest, since the store returns
  newest first. The client passes it back for the next page.
- Fewer than \`limit\` messages came back → the store ran out → \`next_before\` is \`null\`. A full page
  might still be the last one; the client finds out with an empty next page.
- Why a cursor: new messages keep arriving at the top, so \`page=3\` shifts under the reader — the
  classic [offset-pagination flaw](https://use-the-index-luke.com/no-offset). A cursor anchored on the
  last message you saw does not move, whatever lands above it.

A room with 120 messages, read 50 at a time:

| Request | Returned | \`next_before\` |
| --- | --- | --- |
| \`?limit=50\` | messages 120 … 71 | ts of message 71 |
| \`?before=<ts 71>&limit=50\` | messages 70 … 21 | ts of message 21 |
| \`?before=<ts 21>&limit=50\` | messages 20 … 1 (20 of them) | \`null\` |

:::widget status-codes {}

:::details Cache-Control: private, max-age=5 — the header people forget
\`max-age=5\` lets a user who flicks back and forth reuse their own copy for a few seconds.
[\`private\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control#private) is the
part that matters: without it a CDN or a corporate proxy could happily serve one person's private room
to the next person who asks for the same URL. Real APIs go further — sign or opaque-encode the cursor
so clients cannot forge one, cap the total scroll depth, and add an \`ETag\` so a repeated page costs a
\`304\`.
:::

:::quiz
Q: Two new messages arrive between a reader's first and second page. What does the second page contain?
- [x] Exactly the 50 messages older than the last one on page 1 — no gap, no repeat
- [ ] The two new messages, then 48 older ones
- [ ] The last two messages of page 1 again, because everything shifted by two
> \`before\` names a timestamp, and the new messages are newer than it; they cannot land on page 2. Offset pagination would have shown the last two lines of page 1 again, and the reader would wonder whether the room had a stutter.
:::

# Seeding a joiner: a list the writer keeps

A client that joins a room sees an empty screen until someone speaks — unless the server hands it the
last few lines without a trip to the message store. The room bus calls \`remember(room, msg)\` for every
message it delivers, and the three commands run as **one** \`MULTI\`:

\`\`\`text
MULTI
LPUSH  recent:room-7 <json>      # prepend; the list is newest first
LTRIM  recent:room-7 0 49        # keep the newest 50
EXPIRE recent:room-7 3600        # a room quiet for an hour drops out of Redis
EXEC
\`\`\`

:::sequence
{
  "participants": ["room bus", "Redis", "chat-server"],
  "messages": [
    {"from": "room bus", "to": "Redis", "label": "MULTI · LPUSH recent:room-7 · LTRIM 0 49 · EXPIRE 3600 · EXEC", "kind": "sync"},
    {"from": "Redis", "to": "room bus", "label": "[51, OK, 1]", "kind": "reply"},
    {"from": "chat-server", "to": "Redis", "label": "LRANGE recent:room-7 0 49 (a client just joined)", "kind": "sync"},
    {"from": "Redis", "to": "chat-server", "label": "50 values, newest first", "kind": "reply"},
    {"from": "chat-server", "to": "chat-server", "label": "reverse → oldest first → write to the new stream", "kind": "sync"}
  ]
}
:::

- **Push, then trim.** \`LPUSH\` then \`LTRIM\` is the idiom for a capped list: the push makes it 51 long for an instant,
  the trim brings it back to 50, and nobody sees the 51st because both run inside the same \`MULTI\`.
- **Expire on every write.** The \`EXPIRE\` TTL restarts at each message, so only rooms that go quiet expire.
  Set once at creation, it would drop a busy room mid-conversation.
- **A transaction, not a bare pipeline.** A pipeline saves the round trips, but another client's
  \`LRANGE\` can still slip in between the push and the trim; \`MULTI\`/\`EXEC\` makes the three one round
  trip *and* one atomic unit.
- **Reading it back.** \`recent(room)\` is \`LRANGE recent:{room} 0 49\`, reversed once in memory into chronological order
  so the client renders it straight into the timeline. Not \`RPUSH\` instead: the trim would then cut
  the wrong end.
- **Write-through, not cache-aside.** The writer maintains the list; nothing is ever loaded into it
  on a miss. A miss simply means "quiet room", and the client falls back to the history endpoint.

:::quiz
Q: Why run \`EXPIRE recent:{room} 3600\` on every message rather than once when the list is created?
- [ ] Because a key created inside \`MULTI\` cannot be given a TTL later
- [x] So the hour is counted from the last message: a busy room never expires, a quiet one does
- [ ] To reset the list length, since \`LTRIM\` alone does not
> The TTL is a measure of silence. Set once, it counts from the first message, and a room that has been talking non-stop for an hour loses its recent list in the middle of the conversation.
:::

# What to take away

- **Liveness is a lease.** \`SET … EX 30\`, renewed every 10 s; the absence of renewals is the failure
  signal, and expiry is the only reaper. Membership lives in a separate set because it outlives the
  connection.
- **A long-lived stream is a session with a validated first message**, a reader and a writer that run
  independently, and cleanup hung on the call's cancellation rather than on the end of the handler.
- **Fan-out is a question of group names.** A shared group splits the topic; one group per instance
  broadcasts it. Key by room for per-room order; never make the stream wait for the broker.
- **Choose what the live path may lose.** \`latest\` and auto-commit make live delivery at-most-once on
  purpose; the message store is the record, reached by cursor pagination that does not shift under
  the reader and a \`Cache-Control: private\` response that no shared cache may reuse.
- **A writer-maintained capped list** — \`LPUSH\` · \`LTRIM\` · \`EXPIRE\` in one \`MULTI\` — seeds a joiner in
  one round trip, and a miss is not an error.

The closest primary source is Slack's
[*Real-time Messaging*](https://slack.engineering/real-time-messaging/) (Sameer Jain, 2023): the
channel servers, gateway servers and presence servers behind the production version of each piece
above — including why fan-out is split by channel and what a client does on reconnect.
`;
