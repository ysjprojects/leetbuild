/**
 * The learning guide for Support Assistant: the concepts the six steps rest on, in the order a reader
 * meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/doordash-support/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

DoorDash's **Dasher support automation** answers a Dasher's support chat with a language model — and
the part that made it shippable is everything *around* the model: where its facts come from, how long
it may take, who checks its answer before the Dasher sees it, who scores it afterwards. The course
rebuilds that surround as one service, **assistant**; the model and the judge are deterministic
stand-ins the checks serve:

:::diagram
{
  "nodes": [
    {"id": "dasher", "kind": "client", "label": "Dasher app", "sub": "POST /chat · Chat.Stream", "x": 6, "y": 50},
    {"id": "api", "kind": "http", "label": "assistant API", "sub": "step 1 · limit, remember, cache, record", "x": 24, "y": 28},
    {"id": "chat", "kind": "grpc", "label": "Chat", "sub": "step 5 · tokens as they come", "x": 24, "y": 72},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "conv:{session} · rl:{dasher} · answer:{hash}", "x": 46, "y": 12},
    {"id": "pg", "kind": "db", "label": "Postgres · pgvector", "sub": "step 2 · kb_chunks nearest by <=>", "x": 46, "y": 40},
    {"id": "llm", "kind": "external", "label": "model server", "sub": "step 3 · large, then small", "x": 46, "y": 66},
    {"id": "judge", "kind": "external", "label": "LLM judge", "sub": "step 4 · the second tier", "x": 46, "y": 90},
    {"id": "kafka", "kind": "kafka", "label": "support-conversations", "sub": "one record per turn · key = session", "x": 70, "y": 28},
    {"id": "worker", "kind": "service", "label": "quality judge", "sub": "step 6 · judge, write, commit", "x": 90, "y": 28}
  ],
  "edges": [
    {"from": "dasher", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "dasher", "to": "chat", "kind": "grpc", "label": "Chat.Stream"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "history · limit · cache"},
    {"from": "api", "to": "pg", "kind": "plain", "label": "nearest chunks"},
    {"from": "api", "to": "llm", "kind": "grpc", "label": "Generate"},
    {"from": "api", "to": "judge", "kind": "grpc", "label": "Evaluate"},
    {"from": "api", "to": "kafka", "kind": "kafka", "label": "one record per turn"},
    {"from": "chat", "to": "llm", "kind": "grpc", "label": "Stream"},
    {"from": "kafka", "to": "worker", "kind": "kafka", "label": "consume"},
    {"from": "worker", "to": "judge", "kind": "grpc", "label": "Evaluate"},
    {"from": "worker", "to": "pg", "kind": "plain", "label": "quality_scores"}
  ]
}
:::

- **Answer** (step 1): \`POST /chat\` keeps the conversation in Redis, limits each Dasher, answers from
  a cache when it can, records every turn for the judge.
- **Retrieve** (step 2): ten knowledge-base articles cut into chunks, embedded, ranked by Postgres.
- **Generate** (step 3): one prompt format, a 2 s deadline, one retry, a smaller model as fallback.
- **Guard** (step 4): string checks first, an LLM judge second, a human hand-off as the floor.
- **Stream** (step 5): \`Chat.Stream\` relays tokens as they arrive, cancels the model when the guard fails.
- **Judge offline** (step 6): a consumer scores every answered turn and commits only after the write.

# Retrieval-augmented generation: the model is the smallest part

A model asked "when do I get paid?" will answer — fluently, from public text that is partly about
DoorDash and partly wrong. DoorDash's post lists what went wrong before the system around the model
existed: hallucinated policies, wrong refund amounts, answers in the wrong language.

[Retrieval-augmented generation](https://arxiv.org/abs/2005.11401) — RAG — moves the facts out of
the model's weights and into the prompt: find the few paragraphs that answer the question, put them
in front of the model, tell it to answer **only from them** and to cite what it used. The course's
one prompt format:

\`\`\`text
You are a Dasher support assistant. Answer only from the context below and cite the chunks you
use as [kb:<id>]. If the context does not answer the question, say so.

Context:
[kb:pay-0] Dasher earnings for a week are paid out every Monday …
[kb:pay-1] …

History: …
Question: When do I get paid?
Answer:
\`\`\`

The citations are not decoration: because the model names the chunks it used as \`[kb:<id>]\`, the
rest of the system can **check** the answer against the text it was given. Each failure has a
mechanical remedy, and each remedy is a step:

| Failure | Remedy | Where |
| --- | --- | --- |
| Invented policy | reject a citation that was not retrieved | guardrail tier 1 |
| Plausible but ungrounded sentence | every sentence must sit close to some chunk | guardrail tier 1 |
| Grounded, but promises what the policy does not | an LLM judge reads the answer | guardrail tier 2 |
| Slow, or down | a deadline, one retry, a smaller model | model call, streaming |
| A prompt change that quietly regresses | every turn scored offline | quality pipeline |

:::quiz
Q: Why does the prompt insist that the model cite chunks as \`[kb:<id>]\` instead of simply answering?
- [ ] Citations make the answer longer and therefore more helpful
- [x] A cited answer can be checked mechanically against the chunks it claims to rest on
- [ ] The model cannot read a chunk it has not cited
> The citation turns "is this answer true?" — which no string function can answer — into "did this answer draw on text we gave it?", which tier 1 answers with a set lookup and a cosine. The guardrail works because the prompt demands the evidence.
:::

# Chunks, vectors and nearest neighbours

Retrieval is a database problem before it is a model problem. Nobody puts ten articles in a prompt,
so each is cut into **chunks** — windows of 48 words overlapping by 12, so a sentence split by a
boundary still appears whole in one of them — and each chunk is **embedded**: a vector of 512 floats
whose direction encodes its subject, stored beside its text as \`vector(512)\` with
[pgvector](https://github.com/pgvector/pgvector). The course's embedding is a TF-IDF stand-in; a
real one is a model, but retrieval leans on the same properties: the same text always gives the same
vector, texts sharing rare words land close, function words count for nothing.

"Close" is [cosine similarity](https://en.wikipedia.org/wiki/Cosine_similarity) — the angle between
directions, so a long chunk and a short question can still agree. pgvector's \`<=>\` is its distance
form, and ranking is **a query**:

\`\`\`sql
SELECT id, text, embedding <=> $1 AS distance   -- 0 same direction, 2 opposite
FROM kb_chunks
ORDER BY embedding <=> $1
LIMIT 4                                          -- score = 1 − distance, best first
\`\`\`

- **Rank in the database.** \`ORDER BY … LIMIT k\` hands back four rows and lets the planner use a
  vector index (HNSW or IVFFlat in production). The moment the code fetches the table and sorts it in
  memory, the knowledge base cannot grow.
- **Index idempotently.** Ids are \`<article>-<position>\`; \`ON CONFLICT (id) DO NOTHING\` makes a
  re-run insert zero rows.

:::quiz
Q: The knowledge base grows from ten articles to ten thousand. Which search still works?
- [x] \`ORDER BY embedding <=> $1 LIMIT 4\` — Postgres ranks, an index makes it fast
- [ ] \`SELECT * FROM kb_chunks\`, then cosine against every row in the handler
- [ ] Either; both return the same four chunks
> They return the same four chunks today, which is why the wrong one survives review. The in-memory sort moves every vector over the wire on every question; the query moves four rows and gives the planner something to index.
:::

# The endpoint owns the state around a model

\`POST /chat\` is thin on purpose: every decision that needs a model lives behind the guardrail; the
endpoint owns what a chat needs *around* one. Its handler is a straight line, cheapest refusals first:

:::sequence
{
  "participants": ["Dasher app", "assistant API", "Redis", "kb_search", "guardrail", "Kafka"],
  "messages": [
    {"from": "Dasher app", "to": "assistant API", "label": "POST /chat {session_id: s1, dasher_id: d1, message}", "kind": "sync"},
    {"from": "assistant API", "to": "Redis", "label": "INCR rl:d1:29514210 · EXPIRE 60", "kind": "sync"},
    {"from": "Redis", "to": "assistant API", "label": "3 (≤ 20)", "kind": "reply"},
    {"from": "assistant API", "to": "Redis", "label": "LRANGE conv:s1 0 -1 · GET answer:9c1e…", "kind": "sync"},
    {"from": "Redis", "to": "assistant API", "label": "[dasher, assistant] · (nil)", "kind": "reply"},
    {"from": "assistant API", "to": "kb_search", "label": "search(message)", "kind": "sync"},
    {"from": "kb_search", "to": "assistant API", "label": "[login-0, login-1, …]", "kind": "reply"},
    {"from": "assistant API", "to": "guardrail", "label": "answer_or_escalate(message, chunks, history)", "kind": "sync"},
    {"from": "guardrail", "to": "assistant API", "label": "{answer, sources: [login-0, login-1], escalated: false, model: large, tokens: 31}", "kind": "reply"},
    {"from": "assistant API", "to": "Redis", "label": "RPUSH conv:s1 {dasher} {assistant} · EXPIRE 86400 · SET answer:9c1e… EX 3600", "kind": "sync"},
    {"from": "assistant API", "to": "Kafka", "label": "produce support-conversations key=s1 — not awaited", "kind": "async"},
    {"from": "assistant API", "to": "Dasher app", "label": "200 {answer, sources, escalated: false, model: large, cached: false, turn: 2}", "kind": "reply"}
  ]
}
:::

- **Shape, then limit, before any read.** A missing field → **400** \`invalid_request\`;
  \`INCR rl:<dasher>:<unix-minute>\` · \`EXPIRE 60\`, past 20 → **429** \`rate_limited\`. A limited request
  reads nothing and writes nothing.
- **Memory in Redis, with a TTL.** The list \`conv:<session>\` of \`{role, text}\` turns, because the
  next message lands on another replica; \`EXPIRE\` a day, because a chat is not a record.
- **Cache before retrieval and the model.** The key is \`answer:\` + sha256 of the question **after**
  normalisation — lower-cased, whitespace collapsed, trimmed — so \`"How do I get paid?"\` and
  \`"  how do i   get PAID? "\` share a key and the Dasher's words never become a Redis key. The value
  carries the sources; \`EX 3600\` bounds how long a stale article keeps answering. A hand-off is
  **never cached**: it is a statement about the model's failure, not about the question.
- **Record last, never awaited.** One JSON record on \`support-conversations\`, key \`session_id\`,
  handed to the producer; the record is for the judge, not the Dasher.

:::widget cache-aside {}

:::quiz
Q: The guardrail hands a Dasher to a person. Should the endpoint cache that reply under the question?
- [ ] Yes — the next Dasher with the same question gets the same safe outcome without a model call
- [x] No — the hand-off describes a failed generation, not the question; the next Dasher deserves a fresh attempt
- [ ] Yes, but with a shorter TTL
> The cache replays good answers. A hand-off cached for an hour escalates every Dasher asking that question for an hour, on the strength of a model that may have been fine on the next try — one bad generation promoted to policy.
:::

# A deadline is a budget, not a timeout

\`generate\` is the one place the assistant talks to a model: one unary \`Llm.Generate(model, prompt,
max_tokens)\`. The Dasher is owed an answer within a few seconds, and every call spends from that, so
the [deadline](https://grpc.io/blog/deadlines/) goes **on the call** — \`DEADLINE_S\`, 2 s — not in a
sleep around it: a slow model is abandoned at 2 s, and the server is told to stop working on it.

:::sequence
{
  "participants": ["assistant", "llm-large", "llm-small"],
  "messages": [
    {"from": "assistant", "to": "llm-large", "label": "Generate(large, prompt, max_tokens 120) · deadline 2 s", "kind": "sync"},
    {"from": "llm-large", "to": "assistant", "label": "status UNAVAILABLE", "kind": "reply"},
    {"from": "assistant", "to": "llm-large", "label": "Generate(large, same prompt) · after 200 ms · deadline 2 s", "kind": "sync"},
    {"from": "llm-large", "to": "assistant", "label": "status DEADLINE_EXCEEDED", "kind": "reply"},
    {"from": "assistant", "to": "llm-small", "label": "Generate(small, same prompt) · deadline 2 s", "kind": "sync"},
    {"from": "llm-small", "to": "assistant", "label": "GenerateReply{text, tokens, model: small}", "kind": "reply"}
  ]
}
:::

Which status earns which response is the difference between a retry and a retry storm:

| Status | Response |
| --- | --- |
| \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\` — "not right now" | wait 0.2 s, same prompt to the large model once more |
| a second transient failure | the same prompt to \`llm-small\` with \`model="small"\` |
| \`INVALID_ARGUMENT\`, anything else — would fail identically twice | propagate |

- **One prompt**, built once; both attempts and the fallback send the same text, so the smaller
  model answers from the same chunks and the guardrail judges it on the same terms.
- **Three calls at most**: two to the large model, one to the small. \`MAX_TOKENS\` (120) caps the
  reply; \`{answer, model, tokens}\` says which model answered. The hand-off to a person is for answers
  that fail the *guardrail*, not for a model that was slow.

:::widget deadline-retry {"base": 200, "deadline": 2000, "attempts": 2}

:::details What production adds around the same three calls
Callers propagate the *remaining* deadline instead of picking a fresh 2 s per hop; backoff gets
jitter so a fleet does not retry in lockstep; a slow request is hedged against a second replica; and
a circuit breaker opens to the large model once its error rate stays high, so the fallback stops
paying for two failed calls first — Grab's AI Gateway makes that routing a property of the gateway.
:::

:::quiz
Q: The large model answers \`INVALID_ARGUMENT\`. What should \`generate\` do?
- [ ] Wait 0.2 s and retry — every error deserves one retry
- [ ] Send the prompt to the small model; it may accept it
- [x] Raise it — the same prompt will fail the same way, and a retry only spends budget
> \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` say "not right now"; \`INVALID_ARGUMENT\` says "not this". Retrying the second kind costs 200 ms and a model call and changes nothing; the fallback is for a model that is away, not for a request that is wrong.
:::

# Guardrails: cheap checks first, a judge second, a person last

Nothing the model says reaches a Dasher until the guardrail has passed it. DoorDash found one
sophisticated evaluator too slow and too expensive for every turn, and settled on **two tiers** — a
shallow similarity check that catches most of the damage for free, an LLM evaluator for what survives
it — credited with a 90% drop in hallucinations and 99% in compliance failures. The course's
\`check(question, answer, chunks)\` has the same shape:

| Tier | What it asks | Cost | Catches |
| --- | --- | --- | --- |
| 1 — strings | every \`[kb:<id>]\` cited was retrieved; every sentence has cosine ≥ \`MIN_SIMILARITY\` (0.3) with some chunk | no RPC | the invented citation, the sentence that resembles no source |
| 2 — the judge | \`Judge.Evaluate(question, answer, context_ids)\` → groundedness, coherence, compliance, \`pass\` | one call, deadline 2 s | the grounded sentence that promises what the policy does not |
| the floor | after two failed generations, \`HANDOFF_TEXT\` to the Dasher; the rejected text to nobody | a person's time | everything else |

:::sequence
{
  "participants": ["assistant", "llm-large", "judge", "Dasher"],
  "messages": [
    {"from": "assistant", "to": "llm-large", "label": "Generate(prompt with [kb:pay-0] [kb:pay-1] …)", "kind": "sync"},
    {"from": "llm-large", "to": "assistant", "label": "\\"… resolved within 7 days, guaranteed [kb:policy-404].\\"", "kind": "reply"},
    {"from": "assistant", "to": "assistant", "label": "tier 1: policy-404 not retrieved · cosine 0.08 < 0.3 → fail, no judge", "kind": "sync"},
    {"from": "assistant", "to": "llm-large", "label": "Generate(same prompt) · second and last try", "kind": "sync"},
    {"from": "llm-large", "to": "assistant", "label": "\\"Based on [kb:pay-0][kb:pay-1]: Dasher earnings … Monday.\\"", "kind": "reply"},
    {"from": "assistant", "to": "assistant", "label": "tier 1: cited chunks retrieved · cosine 0.58 ≥ 0.3", "kind": "sync"},
    {"from": "assistant", "to": "judge", "label": "Evaluate(question, answer, context_ids) · deadline 2 s", "kind": "sync"},
    {"from": "judge", "to": "assistant", "label": "Scores{groundedness 1.0, compliance 1.0, pass true}", "kind": "reply"},
    {"from": "assistant", "to": "Dasher", "label": "{answer, sources [pay-0, pay-1], escalated false, model large}", "kind": "reply"}
  ]
}
:::

- **Tier 1 is pure functions over strings** — the two shapes a hallucination takes in a retrieval
  system. Any reason → \`ok = false\`, and the judge is **not called**.
- **The judge has the last word.** The faithful answer scores 0.58 against its chunk, the invented
  one 0.08, so 0.3 is a margin, not a verdict — and the survivors are semantic: "which we guarantee"
  cites the right chunks and matches the right text; only a reader can tell it promises what the
  policy does not.
- **No verdict is a failed verdict.** A judge that answers \`UNAVAILABLE\` or misses its deadline is
  \`{ok: false, reasons: ["judge UNAVAILABLE"]}\` — never an exception, never a pass.
- **One more try, then a person.** \`answer_or_escalate\` runs generate → check at most twice; still
  failing → \`{answer: HANDOFF_TEXT, sources: [], escalated: true, model, tokens: 0}\`. The rejected
  text is a local variable that never escapes.

:::quiz
Q: The judge is unreachable for a minute. What does a Dasher whose answer passed tier 1 get?
- [ ] The answer — tier 1 passed, and the judge is only a second opinion
- [x] The hand-off: the second attempt also goes unjudged, and a person follows up
- [ ] The answer, marked as unverified
> Tier 1 catches the cheap shapes of a hallucination, not the semantic ones; that is the judge's job. An unjudged answer is an unknown, and the floor under an unknown is a person. A minute of hand-offs is a spike in the quality table — cheaper than a minute of unchecked promises.
:::

# Streaming: tokens as they come, guarded as they go

A unary answer is judged by one number — time to the reply. A stream is judged by two: **time to the
first token**, which the Dasher feels as responsiveness, and **time between tokens**, which they feel
as the answer being typed. \`Chat.Stream\` relays the model's own stream, \`Llm.Stream\`, token by token
over a server-streaming call, each token a \`ChatEvent{token}\` and the last a
\`ChatEvent{done, sources, escalated, model}\`:

:::sequence
{
  "participants": ["Dasher app", "Chat", "Redis · Postgres", "llm-large", "judge"],
  "messages": [
    {"from": "Dasher app", "to": "Chat", "label": "Chat.Stream(session s-7, \\"My red card was declined…\\")", "kind": "sync"},
    {"from": "Chat", "to": "Redis · Postgres", "label": "LRANGE conv:s-7 · nearest 4 chunks", "kind": "sync"},
    {"from": "Chat", "to": "llm-large", "label": "Llm.Stream(large, prompt, max_tokens 120) · deadline 2 s", "kind": "sync"},
    {"from": "llm-large", "to": "Chat", "label": "Token \\"Based \\" · Token \\"on \\" · … (one every ~40 ms)", "kind": "reply"},
    {"from": "Chat", "to": "Dasher app", "label": "ChatEvent{token} as each arrives · tier 1 every 8 tokens", "kind": "reply"},
    {"from": "llm-large", "to": "Chat", "label": "end of stream (32 tokens)", "kind": "reply"},
    {"from": "Chat", "to": "judge", "label": "Evaluate(…) — the full check", "kind": "sync"},
    {"from": "Chat", "to": "Redis · Postgres", "label": "RPUSH conv:s-7 {dasher} {assistant} · EXPIRE 86400", "kind": "sync"},
    {"from": "Chat", "to": "Dasher app", "label": "ChatEvent{done, sources [red-card-0, red-card-1], model large}", "kind": "reply"}
  ]
}
:::

Everything from the unary path comes along, and changes shape on the way:

- **The deadline covers the whole stream.** gRPC bounds the call, not its first message, so the answer
  streams inside the 2 s and a model slow to start spends the answer's time. Within it, a relay that
  collects the whole answer before writing anything sends the same bytes and is still wrong: it is a
  unary call with extra steps.
- **The fallback narrows.** \`UNAVAILABLE\` *before the first token* → the same prompt to \`llm-small\`.
  A model silent past the deadline, or one that dies mid-answer, has already shown the Dasher half a
  sentence: the honest outcome is a status the app can act on, and nothing is appended to memory.
- **The guard runs on a moving answer.** Every 8 tokens, tier 1 — no RPC — on the text up to the last
  \`.\`, \`!\` or \`?\`; an unfinished sentence looks unlike every chunk and would fail on its own. A failure
  **cancels** the model stream and sends \`ChatEvent{done: true, escalated: true, sources: []}\`; when
  the model's stream ends by itself, the full \`check\` decides the done event.
- **Memory shares the outcome.** Before the done event, both turns go to \`conv:<session>\`: the full
  answer if it passed, \`HANDOFF_TEXT\` if it was escalated.

:::widget grpc-streams {"mode": "server"}

What streaming loses: tier 1 cannot see a sentence before its full stop, so a hallucinating model's
invented sentence reaches the app before the hand-off does — a unary guardrail would never have
allowed that. What it buys is the **cancel**: a model off the rails will happily produce a hundred
more tokens nobody will read, and in production the cancellation has to propagate all the way to the
inference engine.

:::quiz
Q: Tier 1 fails on the 16th token of a streamed answer. What has the Dasher seen, and what happens next?
- [ ] Nothing — the server buffers tokens until the guard passes
- [x] Up to 16 tokens, including the bad sentence; the model stream is cancelled and the done event escalates
- [ ] The tokens vanish from the app when the escalated done event arrives
> Streaming trades the guardrail's "never shown" for a first token in a tenth of the time. The server cannot unsend a token; what it can do is stop generating the rest and tell the app, honestly, that a person is taking over.
:::

# The quality pipeline: judge, write, commit

The guardrail decided what the Dasher saw; the quality pipeline decides what the **team** sees. Every
answered turn leaves the API as one record on \`support-conversations\`, keyed by session:

\`\`\`json
{"session_id": "s-41", "turn": 2, "dasher_id": "d-9", "question": "When do I get paid?",
 "answer": "Based on [kb:pay-0][kb:pay-1]: Dasher earnings … every Monday.",
 "sources": ["pay-0", "pay-1"], "escalated": false, "model": "large", "tokens": 17}
\`\`\`

The judge runs off the request path because its failure modes differ from the answer's: a Dasher
cannot wait for a second model call, but a table can. The consumer, in group \`quality-judge\`, has one
real decision — the **order** of its three steps:

:::sequence
{
  "participants": ["Kafka", "quality-judge", "Judge", "Postgres"],
  "messages": [
    {"from": "Kafka", "to": "quality-judge", "label": "s-41 turn 2 · answered", "kind": "async"},
    {"from": "quality-judge", "to": "Judge", "label": "Evaluate(question, answer, context_ids=sources)", "kind": "sync"},
    {"from": "Judge", "to": "quality-judge", "label": "groundedness 1.0 · coherence 1.0 · compliance 1.0 · pass", "kind": "reply"},
    {"from": "quality-judge", "to": "Postgres", "label": "INSERT INTO quality_scores … ON CONFLICT (session_id, turn) DO UPDATE", "kind": "sync"},
    {"from": "quality-judge", "to": "Kafka", "label": "commit offset — last", "kind": "sync"},
    {"from": "Kafka", "to": "quality-judge", "label": "s-41 turn 3 · escalated", "kind": "async"},
    {"from": "quality-judge", "to": "Kafka", "label": "commit offset (nothing to judge)", "kind": "sync"},
    {"from": "Kafka", "to": "quality-judge", "label": "s-7 turn 1 · answered", "kind": "async"},
    {"from": "quality-judge", "to": "Judge", "label": "Evaluate(…)", "kind": "sync"},
    {"from": "Judge", "to": "quality-judge", "label": "UNAVAILABLE", "kind": "reply"},
    {"from": "quality-judge", "to": "Kafka", "label": "seek back · no commit · redelivered after RETRY_DELAY_S", "kind": "sync"}
  ]
}
:::

- **Auto-commit off; commit last.** The committed offset is the only thing that says "done". A crash
  between write and commit redelivers the record, and the upsert on \`(session_id, turn)\` overwrites
  the row instead of adding a second: Kafka's
  [at-least-once](https://kafka.apache.org/documentation/#semantics) delivery becomes one row however
  many deliveries.
- **An escalated turn is committed, not judged.** It carries the hand-off text, not an answer.
- **UNAVAILABLE is handled by not moving.** The offset is the consumer's memory; leaving it where it
  is costs lag, not data. Any other status propagates.
- **The judge sees what the guardrail saw.** \`context_ids = sources\`, the chunk ids the answer was
  allowed to draw on, so a citation outside them costs groundedness offline as online.

:::widget delivery-semantics {}

DoorDash's judge scores five aspects — retrieval correctness, response accuracy, grammar and
language, coherence to context, relevance — and was trusted only once it agreed with human reviewers;
the same scores gate every prompt change through a Promptfoo regression suite, so a prompt that starts
inventing policies fails a build instead of a Dasher.

:::quiz
Q: The consumer commits the offset before writing the row, and crashes between the two. What is lost?
- [x] That turn's scores: the offset says "done", the record is never redelivered, the row never exists
- [ ] Nothing — the upsert will fill it in on the next delivery
- [ ] One duplicate row, which the primary key rejects
> The upsert only helps when the record comes back, and a committed offset is a promise that it need not. Write first and commit second: the worst case is a redelivery the upsert absorbs, not a hole in the table nobody can see.
:::

# What to take away

- **The model is the smallest part.** Facts come from retrieval, the prompt demands citations, and
  every check compares the answer against the text it was given.
- **Rank in the database.** Overlapping chunks, normalised vectors, cosine distance,
  \`ORDER BY embedding <=> $1 LIMIT k\`; the moment the handler sorts, the knowledge base cannot grow.
- **A deadline is a budget.** On the call, not around it; retry only "not right now", once; a smaller
  model beats an error page; a person is for failed answers, not slow models.
- **Guard cheap first, fail closed.** Strings before RPCs; no verdict is a failed verdict; one more
  generation, then a hand-off; the rejected text reaches nobody — and never the cache.
- **Streaming moves the fallback and the guard** — the fallback to before the first token, the guard to
  a trailing window of complete sentences, where it loses "never shown" and gains the cancel.
- **Observe off the request path, commit last.** One record per turn, never awaited; judge, write,
  commit; an upsert turns at-least-once into one row.

The primary source is DoorDash's
[*Path to high-quality LLM-based Dasher support automation*](https://careersatdoordash.com/blog/large-language-modules-based-dasher-support-automation)
(Zhe Jia, Shuai Wang, Aditi Bamba, Martin Wang, 2024): the pipeline, the two-tier guardrail and its
numbers, the five-aspect judge and why it was calibrated against people, in the team's own words.
`;
