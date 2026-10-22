/**
 * The learning guide for the tumbling-window drill: event time versus processing time, windows,
 * the watermark and what hangs off it — late data, closing, and committing only after the emit is
 * acknowledged. A figure or a table where one says it faster than prose, a pop quiz per section.
 * Rendered at `/kafka-tumbling-window/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A click stream carries its own clock: every record says *when* the click happened, and records reach
the topic out of order. "Clicks per page per minute" is a question about that clock, not the wall
clock — so the aggregator cuts **event time** into fixed 60 s windows, counts into them, and uses a
**watermark** derived from the data to decide when a window is final and can be published once:

:::diagram
{
  "nodes": [
    {"id": "clicks", "kind": "kafka", "label": "clicks", "sub": "{page, ts} · ts = event time, ms", "x": 10, "y": 50},
    {"id": "aggregator", "kind": "service", "label": "windows", "sub": "tumbling 60 s · watermark = max ts − 5 s", "x": 50, "y": 50},
    {"id": "counts", "kind": "kafka", "label": "page-counts", "sub": "key = page · one record per closed window", "x": 90, "y": 50}
  ],
  "edges": [
    {"from": "clicks", "to": "aggregator", "kind": "kafka", "label": "consume · commit after emit"},
    {"from": "aggregator", "to": "counts", "kind": "kafka", "label": "closed windows"}
  ]
}
:::

The contract, in one module:

- \`run()\` joins group \`windows\`, subscribes to \`clicks\` with auto-commit **off**, and loops until stopped.
  Each record is JSON \`{"page", "ts"}\`.
- Windows are **tumbling**, \`WINDOW_MS = 60000\` wide, keyed by \`(page, window_start)\` with
  \`window_start = ts - ts % WINDOW_MS\`.
- The **watermark** is \`max_ts_seen - LATENESS_MS\`, \`LATENESS_MS = 5000\`. It only moves forward.
- An event with \`ts < watermark\` is **late**: dropped, counted in \`stats().late\`.
- After every event, every window whose end \`start + WINDOW_MS\` is \`<= watermark\` **closes**: one record
  per page to \`page-counts\`, key \`page\`, value \`{"page", "window_start", "count"}\`; the window is forgotten.
- The input offsets are committed **only after** the emitted records are acknowledged, and only when
  something was emitted.
- \`stats()\` → \`{"late", "open"}\`; \`shutdown()\` closes the clients and emits nothing.

This is the core of every stream aggregator — Kafka Streams' windowed \`count()\`, Flink's event-time
windows, the per-minute dashboards behind ad serving and product analytics. The counting is trivial;
the watermark and the three decisions it drives are the mechanism.

# Event time is not processing time

Two clocks run over any event stream, and they disagree by an amount nobody controls:

| Clock | What it measures | Who sets it | Why it drifts from the other |
| --- | --- | --- | --- |
| **Event time** | when the click happened — the \`ts\` in the record | the client, at the moment of the click | it is fixed forever; the record carries it wherever it goes |
| **Processing time** | when the aggregator sees the record | the aggregator's wall clock | offline mobile clients flush batches late; partitions interleave; a consumer restarts and replays |

Tyler Akidau's [*Streaming 101*](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-101/)
names the gap **skew**: unbounded and variable. A phone that lost signal in a tunnel delivers ten
minutes of clicks in one burst, every one with an old \`ts\`. Counted by the wall clock, the burst lands
in the wrong minute; a replay of yesterday's topic lands all of yesterday in today.

Counting by event time fixes both and creates the problem the rest of this guide is about: a minute of
event time never visibly *ends*. The next record from the tunnel may belong to 12:03. Some rule must
decide when to stop waiting, and that rule is the watermark.

:::quiz
Q: A consumer that counts "clicks per minute" by its own wall clock is restarted and replays the last hour of \`clicks\` from the committed offset. What happens to the counts?
- [ ] They are recomputed correctly, since the records are the same
- [x] The whole hour lands in the minute the replay runs in
- [ ] The replay is rejected because the records are older than one minute
> The wall clock says "now" for every replayed record. Only the event time inside the record knows which minute a click belongs to, and only an aggregator that reads it reproduces the same counts on a replay.
:::

# Tumbling windows: cutting event time into buckets

A **tumbling** window is fixed-size, aligned, and non-overlapping: every instant of event time belongs
to exactly one window, so every click is counted exactly once. The window an event belongs to is a
pure function of its timestamp:

\`\`\`text
window_start = ts - ts % WINDOW_MS        # WINDOW_MS = 60000
window_end   = window_start + WINDOW_MS   # exclusive
\`\`\`

| \`ts\` | \`ts % 60000\` | \`window_start\` | Window |
| --- | --- | --- | --- |
| 1000 | 1000 | 0 | \`[0, 60000)\` |
| 59999 | 59999 | 0 | \`[0, 60000)\` |
| 60000 | 0 | 60000 | \`[60000, 120000)\` |
| 125000 | 5000 | 120000 | \`[120000, 180000)\` |

Kafka Streams'
[windowing](https://kafka.apache.org/documentation/streams/developer-guide/dsl-api.html#windowing)
calls these *tumbling time windows*, as against *hopping* windows (fixed size, smaller advance, so one
event lands in several) and *session* windows (gaps in activity decide the edges). Tumbling is the one
a per-minute dashboard wants.

The state is small: \`windows[start][page] -> count\` for the open windows, plus \`max_ts\` and a late
counter. Nothing is stored per event. The watermark is **derived**, \`max_ts - LATENESS_MS\`, never
stored — there is nothing to keep in sync.

:::quiz
Q: Why align windows to multiples of \`WINDOW_MS\` rather than start the first window at the first event's \`ts\`?
- [x] So the window an event belongs to is a function of its \`ts\` alone — the same on every instance and every replay
- [ ] Because Kafka timestamps are always multiples of a minute
- [ ] To reduce the number of open windows
> If the first window started at the first event's timestamp, the edges would depend on the order records happened to arrive in; a restart, a second instance or a replay would cut the stream differently. \`ts - ts % WINDOW_MS\` makes "which minute" a property of the click.
:::

# The watermark: a promise derived from the data

The watermark is the aggregator's answer to "how far has event time progressed?" — and, because the
stream is out of order, it is a *conservative* answer: the newest timestamp seen, held back by the
lateness you are willing to tolerate.

\`\`\`text
watermark = max_ts_seen - LATENESS_MS     # LATENESS_MS = 5000
\`\`\`

It is a promise: **no event older than this will be counted**. Everything hangs off that promise.
A window whose end is at or before the watermark can never receive another counted event, so its
count is final and can be published once. The happy path, with the first event at \`ts\` 1000 and the
next at 125000:

:::sequence
{
  "participants": ["clicks", "windows", "page-counts"],
  "messages": [
    {"from": "clicks", "to": "windows", "label": "poll → {page: home, ts: 1000}", "kind": "reply"},
    {"from": "windows", "to": "windows", "label": "window 0 · home = 1 · max_ts 1000 · watermark −4000", "kind": "sync"},
    {"from": "clicks", "to": "windows", "label": "poll → {page: home, ts: 125000}", "kind": "reply"},
    {"from": "windows", "to": "windows", "label": "window 120000 · home = 1 · watermark 120000 ≥ ends of windows 0 and 60000", "kind": "sync"},
    {"from": "windows", "to": "page-counts", "label": "produce key=home {page: home, window_start: 0, count: 1} · flush", "kind": "sync"},
    {"from": "page-counts", "to": "windows", "label": "acked", "kind": "reply"},
    {"from": "windows", "to": "clicks", "label": "commit offsets", "kind": "sync"}
  ]
}
:::

The order of operations inside the handler is the whole correctness argument. For each event:

1. Compute the watermark from the **current** \`max_ts\` and decide: \`ts < watermark\` → late, drop, count.
2. Otherwise fold the event into \`windows[ts - ts % WINDOW_MS][page]\`.
3. Raise \`max_ts\` with this event, recompute the watermark.
4. Close every window with \`start + WINDOW_MS <= watermark\`: emit, wait for the ack, commit.

Six events, in arrival order, through that loop:

| # | Event | Watermark before | Verdict | \`max_ts\` after | Watermark after | Closes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | \`home\` 1000 | −5000 | counts → window 0 | 1000 | −4000 | — |
| 2 | \`about\` 59999 | −4000 | counts → window 0 | 59999 | 54999 | — |
| 3 | \`home\` 61000 | 54999 | counts → window 60000 | 61000 | 56000 | — |
| 4 | \`about\` 57000 | 56000 | 57000 ≥ 56000: counts → window 0 | 61000 | 56000 | — |
| 5 | \`home\` 125000 | 56000 | counts → window 120000 | 125000 | 120000 | windows 0 and 60000 |
| 6 | \`about\` 58000 | 120000 | **late** — dropped, \`late = 1\` | 125000 | 120000 | — |

Event 4 is the one that shows why the watermark is \`max_ts - LATENESS_MS\` and not \`max_ts\`: it arrives
after a newer event and belongs to an older window, but it is inside the lateness bound, so it counts
in its own window — which is still open, because \`60000 > 56000\`. Event 5 closes windows 0 and 60000
in one step (\`0 + 60000 ≤ 120000\` and \`60000 + 60000 ≤ 120000\`), emitting \`home: 1\` and \`about: 2\`
for window 0 and \`home: 1\` for window 60000. Window 120000 stays open; \`stats()\` says \`open: 1\`.

Three properties of this watermark:

- **Monotone.** \`max_ts\` only rises, so the watermark only rises. A closed window stays closed.
- **Data-driven.** A replay of yesterday's topic closes yesterday's windows the same way; a quiet stream
  leaves its last window open — nothing is published on a guess.
- **Heuristic.** Five seconds is a bet about how late events arrive. The Dataflow paper
  ([Akidau et al., VLDB 2015](https://www.vldb.org/pvldb/vol8/p1792-Akidau.pdf)) separates *perfect*
  watermarks, possible only when the source knows its own completeness, from *heuristic* ones like
  this one: a trade-off between latency and the chance of calling an event late.

:::quiz
Q: \`LATENESS_MS\` is raised from 5000 to 60000. What changes?
- [ ] Windows become 60 s longer
- [x] Every window is published 55 s later in stream time, and fewer out-of-order events are counted as late
- [ ] Late events are counted into their windows instead of dropped
> The window edges are set by \`WINDOW_MS\`; lateness only holds the watermark further behind the newest event. A window closes when the watermark passes its end, so a larger bound means a later close — the price paid for tolerating a longer tail of out-of-order arrivals.
:::

# Late data: dropped, counted, never reopened

An event behind the watermark has missed its window. The count for that window may already be on
\`page-counts\`, consumed and graphed; the window's state is gone. The drill makes the simplest honest
choice: drop the event and count it.

| The event | Verdict | Why |
| --- | --- | --- |
| \`ts >= watermark\`, newest window | counts | the ordinary case |
| \`ts >= watermark\`, an older window still open | counts, in its own window | out of order but inside the bound; this is what the bound is for |
| \`ts < watermark\`, its window already emitted | dropped, \`late += 1\` | the count is published; counting it now would mean a second, contradicting record |
| \`ts < watermark\`, its window never opened | dropped, \`late += 1\` | the watermark has already passed it; it would close on the next event with a count missing everything before |

The **late counter** is the operational signal. A steady trickle is the price of a 5 s bound; a jump
means a client population is flushing later than the bound assumes, and the honest responses are to
widen the bound or to fix the source — not to silently reopen windows.

:::details What real systems do with late data
[*Streaming 102*](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-102/) frames the
choice as *accumulation*: **discarding** (what the drill does), **accumulating** (emit a corrected
count when a late event arrives — downstream overwrites by \`(page, window_start)\`) and **accumulating
and retracting** (emit the correction and a retraction of the previous value, so a downstream sum stays
right). Kafka Streams keeps a window's state for a configurable *grace period* after the watermark
passes and emits updates for late arrivals inside it; Flink's *allowed lateness* is the same idea, with
a side output for events beyond it. All of them pay in state: every window that may still be updated
must be kept, along with what was already emitted.
:::

:::quiz
Q: A late event arrives for a window whose count is already on \`page-counts\`. Why not reopen the window and count it?
- [x] A second record for the same window would contradict the first; without a correction protocol downstream, the published count must stay the only one
- [ ] Reopening a window is slower than dropping an event
- [ ] Because the event's \`ts\` is corrupt
> "Publish once" is the promise the watermark bought. A system that wants to count late data must change the output contract — emit corrections, or retractions — and keep state for closed windows. The drill chooses the simpler contract and makes the loss visible in \`stats().late\`.
:::

# Emit, wait for the ack, then commit

Closing a window is the only moment with a side effect, and the order of the two writes — records to
\`page-counts\`, offsets to the consumer group — decides what a crash costs. Auto-commit is off because
the consumer client would otherwise commit on its own schedule, with no idea whether the window it
just closed has been produced. Commit first and a crash in between loses the window:

:::sequence
{
  "participants": ["clicks", "windows (naive)", "page-counts"],
  "messages": [
    {"from": "clicks", "to": "windows (naive)", "label": "poll → {page: home, ts: 125000}", "kind": "reply"},
    {"from": "windows (naive)", "to": "windows (naive)", "label": "watermark 120000 → windows 0 and 60000 close", "kind": "sync"},
    {"from": "windows (naive)", "to": "clicks", "label": "commit offsets (auto-commit, or commit before produce)", "kind": "sync"},
    {"from": "windows (naive)", "to": "windows (naive)", "label": "crash — before produce reaches the broker", "kind": "sync"},
    {"from": "clicks", "to": "windows (naive)", "label": "restart: resume after 125000; the events of windows 0 and 60000 are never re-read", "kind": "reply"},
    {"from": "windows (naive)", "to": "page-counts", "label": "nothing — the two windows are gone for good", "kind": "async"}
  ]
}
:::

Emit, wait for the broker's acknowledgement, and only then commit. Now the same crash replays the
window instead:

:::sequence
{
  "participants": ["clicks", "windows", "page-counts"],
  "messages": [
    {"from": "clicks", "to": "windows", "label": "poll → {page: home, ts: 125000}", "kind": "reply"},
    {"from": "windows", "to": "windows", "label": "watermark 120000 → windows 0 and 60000 close", "kind": "sync"},
    {"from": "windows", "to": "page-counts", "label": "produce home {0, 1} · about {0, 2} · home {60000, 1} · flush", "kind": "sync"},
    {"from": "page-counts", "to": "windows", "label": "acked (acks=all)", "kind": "reply"},
    {"from": "windows", "to": "windows", "label": "crash — before the commit", "kind": "sync"},
    {"from": "clicks", "to": "windows", "label": "restart: resume from the last commit; events 1–5 are re-read", "kind": "reply"},
    {"from": "windows", "to": "page-counts", "label": "the same three records, a second time · flush · acked", "kind": "sync"},
    {"from": "windows", "to": "clicks", "label": "commit offsets", "kind": "sync"}
  ]
}
:::

- **Flush, or await the send.** \`produce\` hands the record to a buffer; only the acknowledgement says
  the broker has it. The commit sits behind that acknowledgement — so a stalled output topic stalls
  the commit too.
- **Commit only when something closed.** An event that opens or grows a window has produced nothing;
  committing its offset would commit input whose output does not exist yet.
- **The replay is a duplicate, not a loss.** The three records land twice. Downstream dedupes by
  \`(page, window_start)\` — why the value carries both, and why the record is keyed by \`page\`, so one
  page's windows sit on one partition, in order, where a consumer can overwrite.

This is Kafka's [at-least-once](https://kafka.apache.org/documentation/#semantics) processing in its
plainest form: output first, then the offset. A transactional emit-and-commit — offsets sent inside the
same transaction as the records — turns the duplicate into exactly-once; the drill leaves that out.

:::widget delivery-semantics {}

The restart in the second figure also shows what the drill does **not** checkpoint: the open windows.
On restart, \`windows\` is empty and \`max_ts\` is 0; the recount from the committed offset rebuilds them,
correct because the commit only ever moves past events whose windows were emitted. Real stream
processors keep open windows in a state store backed by a changelog topic, and track a watermark per
input partition, merged by taking the minimum, so a busy partition cannot outrun a quiet one.

:::quiz
Q: The aggregator closes a window, produces its records, and crashes before committing. After restart, what is on \`page-counts\`?
- [ ] Nothing for that window; the crash rolled the produce back
- [x] The window's records twice — once from before the crash, once from the replay
- [ ] The records once, because the broker deduplicates by key
> The produce was acknowledged before the crash, so it is on the topic. The offsets were not committed, so the replay re-reads the window's events, rebuilds the same counts and produces them again. Downstream dedupes by \`(page, window_start)\`; nothing is lost.
:::

# What to take away

- **Count by the clock inside the record.** Event time is the click's own timestamp; processing time
  is an accident of delivery. Only event time survives a replay.
- **Tumbling windows are a pure function.** \`ts - ts % WINDOW_MS\` assigns every click to exactly one
  aligned 60 s bucket, the same on every instance and every run.
- **The watermark is a promise, derived from the data.** \`max_ts - LATENESS_MS\`, monotone, never
  stored: nothing older will be counted, so a window whose end it has passed can be published once.
- **Decide late before raising the clock.** Behind the watermark: drop and count. Inside the bound:
  count, even into an older window. Then close everything the new watermark has passed.
- **Emit, wait for the ack, then commit — and only when something was emitted.** The other order loses
  a window on a crash; this order replays it, and \`(page, window_start)\` lets downstream dedupe.

The primary reference is Tyler Akidau's
[*The world beyond batch: Streaming 102*](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-102/)
(2016): the Dataflow model's windowing, watermarks, triggers and accumulation modes, worked through on
one out-of-order stream — the vocabulary every stream processor since has borrowed.
`;
