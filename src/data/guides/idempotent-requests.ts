import type {Source} from '@/lib/types';

/**
 * The failure-mode guide for idempotent requests: a retried POST that becomes a second effect, and
 * the key, fingerprint and recorded response that turn it back into the first answer. Rendered at
 * `/guides/idempotent-requests`.
 */
export const guide = `# A retry is not a new request

A client sends \`POST /v1/charges\`. The server validates it, writes the charge, commits, and starts
writing the 201. Somewhere between the commit and the client's socket the connection drops, or the
client's 5-second timeout fires 40 ms too early. From the client's side nothing came back. It cannot
tell "never arrived" from "done, answer lost", so it does the only safe-looking thing and sends the
request again. The server sees a fresh POST, writes a second charge, and the customer pays twice.

:::sequence
{
  "participants": ["Client", "API", "Charges"],
  "messages": [
    {"from": "Client", "to": "API", "label": "POST /v1/charges {amount: 2000}", "kind": "sync"},
    {"from": "API", "to": "Charges", "label": "INSERT charge ch_1 · COMMIT", "kind": "sync"},
    {"from": "API", "to": "Client", "label": "201 ch_1 (lost: timeout at the client)", "kind": "reply"},
    {"from": "Client", "to": "API", "label": "retry: POST /v1/charges {amount: 2000}", "kind": "sync"},
    {"from": "API", "to": "Charges", "label": "INSERT charge ch_2 · COMMIT", "kind": "sync"},
    {"from": "API", "to": "Client", "label": "201 ch_2: the customer is charged twice", "kind": "reply"}
  ]
}
:::

Nothing in that trace is a bug on its own. The network failed in the most ordinary way, and the client
retried as every client library does. The flaw is that the endpoint has no way to recognise the second
request as the first one again. \`GET\`, \`PUT\` and \`DELETE\` are idempotent by definition: doing them
twice leaves the same state as doing them once. \`POST\` and \`PATCH\` are not, so an endpoint that
creates something, charges something, sends something or starts something has to be *made*
idempotent.

The tool is an **idempotency key**: a unique value the client generates once per intended operation
and sends with every attempt, usually as the \`Idempotency-Key\` header. The server remembers what it
did under that key and, when the key comes back, answers with what it answered the first time instead
of doing it again. The failure mode this guide covers is every way that promise quietly breaks:

- **No memory at all.** Every POST mints a fresh id, so every retry is a second effect.
- **Memory with the wrong scope.** Keys stored globally, so tenant B's \`order-1\` replays tenant A's
  answer, or keys that share a namespace with another system's keys.
- **Memory of the key but not the request.** A key reused for a *different* body is answered with
  the old response, and the client believes its new request happened.
- **Memory that is not atomic.** Two retries arrive together, both look the key up, both miss, and
  both act.
- **Memory recorded apart from the effect.** The effect commits and the record does not (or the other
  way round), so a crash leaves a key that replays nothing or an effect that no key remembers.

:::quiz
Q: A client's \`POST /v1/transfers\` times out after 5 seconds with no response. What does the client actually know?
- [ ] The transfer failed, so it is safe to send a new one
- [ ] The transfer succeeded, because the server never returned an error
- [x] Nothing about the outcome: the request may never have arrived, may still be running, or may have completed with the answer lost
> A timeout is an unknown outcome, not a failure. The only way a retry stays safe is if the server can recognise it as the same operation and answer it from what already happened.
:::

# How it shows up in the courses

The debugging courses put an \`Idempotency-Key\` on almost every endpoint that creates something, and
the starters get it wrong in a handful of recurring ways. You will meet these shapes:

- **The retry that bills twice.** In [AI Cost Meter, step 1](/cost-meter/1-endpoint) a gateway that
  timed out waiting for the 202 reports the same usage again, and the starter stores a second row under
  a fresh id. Finance bills from those rows. The subtler half of the same step is a key that comes back
  with a *different* report: answering it from the old row hides a report the client believes was
  recorded.
- **The retry that refunds twice.** [Refund Service, step 1](/refund-service/1-endpoint) mixes this
  failure mode with request boundaries: a client that retries after a timeout is refunded twice, and
  money is the effect you can least afford to repeat.
- **Two replicas, one retry.** In [Support Automation Platform, step 1](/support-automation/1-turn-endpoint)
  the starter does look the key up before it stores the turn. The question the step asks is what happens
  when the same retry reaches two replicas in the same millisecond, and what a missing key does to a
  reasoning loop that may run a write tool.
- **The wrong namespace.** In [Shadow Evaluation, step 1](/shadow-eval/1-endpoint) the replay logic is
  all there, but the records land where production's request path also looks, so a shadow config can
  answer production's next request. Scope is part of the key.
- **The physical device.** In [IoT Hub, step 1](/iot-hub/1-endpoint) an operator app that times out and
  retries an unlock opens the door twice. The key there is not a header but an idempotency id per
  device, and a replay must queue nothing.
- **A retry told apart from a new version.** [Prompt Registry, step 1](/prompt-registry/1-endpoint) and
  [Checkpoint Store, step 1](/checkpoint-store/1-endpoint) have no client key at all: the version number
  or the chunk index *is* the identity. The starters answer as if every write took effect, or accept a
  replay that carries different bytes, and a version stops naming one set of bytes.

When you open a step like these, read the handler as a sequence of round trips and ask three questions:
**where is the key stored and under what scope, what is compared before the replay, and what happens
if two of these requests run at once?** The checks are built around the answers.

# The mechanism: claim, act, record, replay

An idempotent endpoint keeps one **record** per \`(scope, key)\`. The record holds:

| Field | Why it is there |
| --- | --- |
| scope (tenant, user, device) | Keys are chosen by clients; two clients will pick \`order-1\`. The record is found by the pair, never the key alone. |
| key | The client's name for the operation, the same on every attempt. |
| fingerprint | A digest of the request that matters (canonical body, method, path). A key reused with another fingerprint is a client bug to refuse, not a retry to replay. |
| state | \`started\` while the first attempt runs, \`finished\` once it has an answer. |
| status and body | The response the first attempt sent, so a replay sends the same thing back. |
| expiry | Keys protect near-term retries, not history; the published horizon (often 24 hours) bounds storage. |

The request then runs in four moves:

1. **Refuse first.** Authenticate, take the scope from the credential, validate the key's format and
   the body. A request refused here records nothing, so the client can correct it and try again with
   the same key.
2. **Claim.** Create the record in one atomic step that fails if it already exists: \`SET NX\` in Redis,
   \`INSERT ... ON CONFLICT DO NOTHING\` against a unique \`(tenant, key)\` index in SQL. Whoever creates
   it runs the operation; everyone else reads it.
3. **Act and record.** Perform the effect and write the response into the record, together.
4. **Replay or refuse.** A request that found an existing record compares fingerprints (different:
   refuse), then state (\`started\`: answer 409, try again later), then sends the recorded status and
   body.

Try it: send the same request twice with one key, then with a new key, then race two requests with
the same key, and watch the key store and the responses.

:::widget idempotency {}

## In Python, with Redis as the key store

The claim is one command, so two replicas cannot both win it. The key carries the tenant, and the
record carries the fingerprint:

\`\`\`python
async def create_charge(request: Request) -> JSONResponse:
    tenant = tenant_from_credential(request)          # never from the body
    key = request.headers.get("Idempotency-Key", "")
    if not KEY_FORMAT.fullmatch(key):
        return problem(400, "Idempotency-Key is required")
    charge = parse_charge(await request.json())       # 400/422 here: nothing recorded
    fingerprint = hashlib.sha256(canonical_json(charge)).hexdigest()
    slot = f"idem:{tenant}:{key}"
    claimed = await redis.set(slot, json.dumps({"fp": fingerprint, "state": "started"}),
                              nx=True, ex=IDEMPOTENCY_TTL_S)
    if not claimed:
        return replay_or_refuse(await redis.get(slot), fingerprint)
    created = await charges.create(tenant, charge)
    await redis.set(slot, json.dumps({"fp": fingerprint, "state": "finished",
                                      "status": 201, "body": created}), ex=IDEMPOTENCY_TTL_S)
    return JSONResponse(created, status_code=201)
\`\`\`

Read it again for the gap: \`charges.create\` and the second \`redis.set\` are two systems. A crash
between them leaves a \`started\` record that answers 409 until it expires, and then a retry charges
again. That is the price of keeping the record in a different store from the effect, and the reason
the next stack does it differently.

## In TypeScript, with the record in the same transaction

When the effect lives in a SQL database, the record can live in the same transaction, and the unique
index does the claiming:

\`\`\`typescript
await db.query('BEGIN');
const claim = await db.query(
  'INSERT INTO idempotency (tenant, key, fingerprint) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
  [tenant, key, fingerprint],
);
if (claim.rowCount === 0) {
  await db.query('ROLLBACK');
  return replayOrRefuse(reply, await loadRecord(tenant, key), fingerprint);
}
const charge = await insertCharge(db, tenant, body);
await db.query('UPDATE idempotency SET status = 201, body = $3 WHERE tenant = $1 AND key = $2', [
  tenant,
  key,
  charge,
]);
await db.query('COMMIT');
return reply.code(201).send(charge);
\`\`\`

The charge and its record commit or vanish together. A concurrent second \`INSERT\` waits on the first
transaction's row lock: if the first commits, the second does nothing and replays; if it rolls back,
the second claims the key and runs.

## In Go, the replay branch

The branch that runs when the record exists is where most starters cut a corner: they find the key and
send back whatever is there.

\`\`\`go
rec, found, err := records.Get(ctx, tenant, key)
if err != nil {
	writeProblem(rw, http.StatusServiceUnavailable, "try again")
	return
}
switch {
case !found:
	createAndRecord(rw, r, tenant, key, fp)
case rec.Fingerprint != fp:
	writeProblem(rw, http.StatusConflict, "Idempotency-Key reused with a different request")
case rec.Status == 0:
	writeProblem(rw, http.StatusConflict, "a request with this key is still in progress")
default:
	writeRecorded(rw, rec.Status, rec.Body)
}
\`\`\`

Three answers, three meanings: the same request gets the same response; a different request under the
same key is refused and changes nothing; a request that overlaps the first attempt is told to wait.

:::details Why "look it up, then insert" is not a claim
\`if not store.get(key): store.put(key, ...)\` is two round trips. Two replicas running the same retry
both get \`None\`, both act, and both put. It passes every test that sends requests one after another,
and fails the first time a load balancer and a client retry line up. The claim has to be one atomic
operation the store arbitrates: \`SET NX\`, a unique constraint, a compare-and-set, or a Lua script.
The [atomic state guide](/guides/atomic-state) covers the general shape.
:::

:::quiz
Q: The handler stores the idempotency record *before* it validates the body. A client sends a request with a typo, gets a 400, fixes the body and retries with the same key. What happens?
- [ ] The corrected request is processed, because the first attempt failed
- [x] The retry finds a record whose fingerprint differs (or whose stored answer is the 400) and is refused or replayed, so the corrected request never runs
- [ ] The two requests are merged
> Refusals that come before any effect should record nothing. Stripe documents exactly this: when parameters fail validation, no idempotent result is saved, so the client can retry. Recording before validating turns a recoverable mistake into a key that is burnt.
:::

# Versions, natural keys and retries told apart

Not every endpoint needs a client-chosen key. When the resource already has an identity the client
controls, that identity can do the key's job:

- **Immutable versions.** \`(name, version)\` in a registry names one set of bytes, forever. A
  registration of the same bytes under the same version is a retry: answer the existing version,
  marked as not newly created. Different bytes under an existing version are a conflict: **409**, and
  the stored version is untouched. A content hash makes the comparison exact.
- **Natural keys.** \`(device_id, command_id)\`, \`(job_id, url)\`, \`(upload_id, chunk_index)\`: the
  request names its own slot. A replay finds the slot filled with the same digest and changes nothing;
  a replay with a different digest is refused.
- **Content addressing.** When the content *is* the identity (a dataset item, a dedupe mark), the
  digest is the key, scoped by whatever else the meaning depends on (the tenant, the label spec).

The rule underneath is the same as with headers: a retry carries the same identity **and** the same
content; anything else is either a new operation or a mistake, and must not be answered as the old
one. A set-if-absent store that returns \`false\` when the slot is taken does half the work; the handler
has to look at that \`false\` and decide between "same bytes, replay" and "different bytes, 409"
instead of answering 201 either way.

:::quiz
Q: \`POST /v1/prompts\` registers \`{name: "summarise", version: 3, template: T}\`. Version 3 of \`summarise\` already exists with template T'. What should the client get back?
- [ ] 201 with the new template, since the client is the owner
- [ ] 200 with version 3, because the key matches
- [x] 409, with version 3 still holding T'
> A version that can be rewritten is not a version: every eval record and rollback that pointed at version 3 would now point at different text. The same bytes would be a retry (answer the existing version); different bytes are a new version the client must name.
:::

# The fix and its trade-offs

Put together, a correct idempotent endpoint does these in order: take the scope from the credential;
validate the key and the body and refuse before any write; claim \`(scope, key)\` atomically with a
fingerprint; perform the effect and record the response with it; and on a claim that fails, compare the
fingerprint, check the state, and replay.

Every one of those choices costs something:

| Decision | Options | What it costs |
| --- | --- | --- |
| Key required? | Required on every create, or optional | Required makes clients do work and answers 400 without one; optional leaves every client that forgets with double effects. Endpoints with money or physical effects should require it. |
| Status for a reused key | 409 Conflict (the courses, many APIs) or 422 Unprocessable Content (the IETF specification) | Either works if it is documented and never 2xx. 409 for "in progress" is common to both. |
| What the fingerprint covers | Whole canonical body, selected fields, or a request digest | Too little and a different request replays the old answer; too much (a timestamp field, a trace id) and every retry looks like a different request. |
| Where the record lives | Same transaction as the effect, or a separate store | Same transaction is exact but ties you to that database; a separate store (Redis) is fast and shared, and leaves a window between effect and record. |
| In-flight duplicates | Answer 409 at once, or wait for the first to finish | 409 is simple and honest; waiting gives nicer clients and holds connections. |
| Expiry | A fixed horizon (24 hours is common), or never | Keys are not an archive. After expiry a reused key is a new request, so the horizon must outlast the longest client retry schedule. |
| What a replay returns | The recorded status and body, including errors, or a fresh read | A recorded answer is what idempotency promises; a fresh read can disagree with what the first attempt said. |

:::details When the effect leaves your database
A charge at a payment provider, an email, a message to a device: once a request calls out, there is no
transaction that covers both sides. The pattern Brandur Leach describes for Stripe-style keys splits the
request into **atomic phases** between foreign calls, records a **recovery point** after each, and
passes an idempotency key *downstream* too, so a retry resumes from the last point instead of starting
over. A timeout from the provider is an unknown outcome to reconcile, not a failure to resend; that
part belongs to the [deadlines and retries guide](/guides/deadlines-and-retries).
:::

:::details A claim that can be abandoned
A \`started\` record whose owner crashed blocks its key until something decides it is dead. Give the
claim a deadline (a lock timeout, a TTL on the \`started\` state) so a later retry may take it over, and
make sure the effect itself is safe to attempt again by then. That is a lease, and the
[leases guide](/guides/leases) covers fencing a holder that comes back late.
:::

:::quiz
Q: Records live in Redis under \`idem:{key}\` with a 24-hour TTL. Two tenants both use \`Idempotency-Key: 1\`. What goes wrong?
- [ ] Nothing: keys are unique per request
- [x] The second tenant's request is answered with the first tenant's recorded response, which leaks its data and skips its effect
- [ ] Redis refuses the second \`SET\`
> Clients choose keys, and clients reuse obvious ones. The IETF specification recommends a composite lookup key that combines the client's key with attributes only the server knows, such as the authenticated tenant. The scope is part of the key.
:::

# Proving it with an outcome test

A test for idempotency asserts **what the world looks like** after the requests, not which store
command the handler called. Count the rows, the charges, the queued jobs, the commands sent to the
device; compare the responses; check what a refused request left behind.

\`\`\`python
async def test_a_retry_is_one_charge(client, charges):
    headers = {"Authorization": "Bearer tenant-a", "Idempotency-Key": "k-1"}
    body = {"amount": 2000, "currency": "usd"}

    first = await client.post("/v1/charges", json=body, headers=headers)
    again = await client.post("/v1/charges", json=body, headers=headers)
    assert first.status_code == 201
    assert (again.status_code, again.json()) == (first.status_code, first.json())
    assert charges.count("tenant-a") == 1

    changed = await client.post("/v1/charges", json={**body, "amount": 9999}, headers=headers)
    assert changed.status_code == 409
    assert [c["amount"] for c in charges.all("tenant-a")] == [2000]

    other = await client.post("/v1/charges", json=body,
                              headers={**headers, "Authorization": "Bearer tenant-b"})
    assert other.status_code == 201 and other.json()["id"] != first.json()["id"]
\`\`\`

Then the cases that sequential tests never reach:

- **Concurrency.** Hold the effect open (a store whose \`create\` waits on an event), fire two requests
  with the same key with \`asyncio.gather\`, release, and assert one effect and one 201; the other
  answer is a replay or a 409.
- **Refusal then retry.** Send an invalid body with key \`k-2\`, expect 400 and no record; send the valid
  body with \`k-2\`, expect 201 and one effect.
- **Crash between effect and record.** Make the record write fail after the effect, retry, and decide
  what you expect: with the record in the same transaction, no effect and a clean retry; with a
  separate store, a 409 until the claim expires, never a second effect.
- **Mutation check.** Delete the claim, or drop the tenant from the key, or skip the fingerprint
  comparison. A good test fails for each one. If one still passes, that line was never proven.

:::quiz
Q: Which assertion proves that a retried \`POST\` is idempotent?
- [ ] The handler called \`redis.set\` with \`nx=True\`
- [ ] The second response has status 200 or 201
- [x] After two identical requests, the store holds exactly one effect and both responses carry the same id
> Implementation assertions break when the implementation changes and pass when it is wrong in a way the mock did not model. Status alone passes for a handler that creates a second row and answers 201 again. The effect count and the id are the outcome the client cares about.
:::

# What to take away

- **A timeout is an unknown outcome.** Clients will retry, so every endpoint with an effect must turn a
  retry back into the first answer.
- **Scope the key.** The record is found by \`(tenant or user or device, key)\`, never the key alone, in
  a namespace no other path shares.
- **Remember the request, not just the key.** A fingerprint tells a retry from a different request
  under the same key; the different one is refused and changes nothing.
- **Claim atomically, record with the effect.** One \`SET NX\`, one unique insert, one script; and the
  response recorded where it cannot drift from what happened.
- **Refuse before you record.** A validation failure leaves no key behind.
- **Immutable means immutable.** Same bytes under a version is a retry; different bytes is 409.
- **Prove it by counting effects**, under concurrency, with a refused request and a crash in the
  middle.
`;

export const sources: Source[] = [
  {
    title: 'The Idempotency-Key HTTP Header Field',
    url: 'https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/',
    kind: 'docs',
    venue: 'IETF httpapi working group',
    by: 'Jayadeba Jena, Sanjay Dalal, Dmitrii Tishkin',
    date: '2026-10-22',
    takes:
      'The header and its rules: a key must not be reused with a different payload, a fingerprint tells them apart, a reused key is 422 and a concurrent one 409, and the lookup key should combine the client key with attributes only the server knows.',
  },
  {
    title: 'Designing robust and predictable APIs with idempotency',
    url: 'https://stripe.com/blog/idempotency',
    kind: 'post',
    venue: 'Stripe blog',
    by: 'Brandur Leach',
    date: '2017-02-22',
    takes:
      'Why a client cannot tell a lost response from a failed request, and how an idempotency key on every mutating POST lets it retry until it gets an answer, with backoff and jitter.',
  },
  {
    title: 'Idempotent requests',
    url: 'https://docs.stripe.com/api/idempotent_requests',
    kind: 'docs',
    venue: 'Stripe API reference',
    takes:
      'A production contract: the first response (status and body) is saved and replayed, parameters are compared to refuse misuse, keys are pruned after 24 hours, and requests that fail validation or collide with a concurrent one record nothing.',
  },
  {
    title: 'Implementing Stripe-like Idempotency Keys in Postgres',
    url: 'https://brandur.org/idempotency-keys',
    kind: 'post',
    venue: 'brandur.org',
    by: 'Brandur Leach',
    date: '2017-10-27',
    takes:
      'The key relation unique on (user, key) with the request parameters and a lock, 409 for a mismatched or in-progress key, and atomic phases with recovery points for requests that call foreign systems.',
  },
];
