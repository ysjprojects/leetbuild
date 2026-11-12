import type {Source} from '@/lib/types';

/** The request-boundaries guide: who is asking, what they may touch and send, and what goes back out. */
export const guide = `# The failure mode at a glance

Every request carries two kinds of data: what the caller **asks for** and what the server **must
decide**. The failure mode is a handler that lets the first kind stand in for the second. The
tenant comes from a JSON field instead of the credential, a record is loaded by the id in the path
whichever tenant owns it, a 300 MB upload reaches the model before anyone measures it, and the
answer (or the log line written beside it) carries the customer's text back out.

Each of those starters works. The demo passes, the happy path is fast, and the test that sends a
well-behaved request from one tenant is green. The flaw only shows when a caller sends what an
honest client never would:

:::sequence
{
  "participants": ["Caller (globex)", "API", "Store", "Logs"],
  "messages": [
    {"from": "Caller (globex)", "to": "API", "label": "POST /v1/search · X-Tenant-Id: globex · {tenant: acme, k: 500}", "kind": "sync"},
    {"from": "API", "to": "API", "label": "tenant = body.tenant or header → acme · k = min(k, 100)", "kind": "sync"},
    {"from": "API", "to": "Store", "label": "nearest(acme, query, 100)", "kind": "sync"},
    {"from": "Store", "to": "API", "label": "acme's documents", "kind": "reply"},
    {"from": "API", "to": "Logs", "label": "log.info(request body): the query, verbatim", "kind": "async"},
    {"from": "API", "to": "Caller (globex)", "label": "200 · 100 hits from another tenant, k silently rewritten", "kind": "reply"}
  ]
}
:::

Four boundaries sit at the edge of every handler. A debugging step's flaws almost always cross one
of them:

| Boundary | The question | What the server decides from | Typical refusal |
| --- | --- | --- | --- |
| Identity | Who is asking? | the authenticated credential (\`Authorization\`, \`X-Tenant-Id\` set by the gateway, \`X-User-Id\`, \`X-Role\`) | **401** without one |
| Object scope | May they touch this record? | the record's owner, compared with the identity | **404**, exactly as for a missing record |
| Admission | Is the request one we will do work for? | allowlists, ranges, byte limits, media types | **400**, **413**, **415**, **422**, before any write, fetch or call |
| Egress | What may leave? | a projection built for this caller | escaped, masked, signed, logged as ids and sizes |

The status codes are the vocabulary. Hover the ones this guide leans on:

:::widget status-codes {}

:::quiz
Q: A handler reads \`tenant = body.get("tenant") or request.headers["X-Tenant-Id"]\`. Every request in the test suite sends the header and no body tenant. What is wrong?
- [ ] Nothing: the header is the fallback, so authenticated callers are covered
- [x] Any authenticated caller reads or writes any tenant's data by naming it in the body
- [ ] The header should be the first choice only for read requests
- [ ] It is only a problem if tenant ids are guessable
> The credential proves who the caller is; the body is whatever the caller typed. Preferring the body hands the identity decision to the client. Tenant ids being hard to guess does not help: they appear in URLs, logs and support tickets.
:::

# How it shows up

In production this failure mode rarely pages anyone. It shows up as a support ticket, an audit
finding or a bill:

- A customer sees another customer's document, transcript or invoice after "trying an id".
- A probe answers **403** for ids that exist and **404** for ids that do not, so a script maps
  which accounts a competitor has.
- The model bill spikes from requests that were rejected anyway, or from a single request carrying
  10,000 inputs.
- A field that "fits" in characters overflows a column, a token budget or a downstream limit in
  bytes; or the service quietly truncates text and stores a different document from the one sent.
- A crawler fetches \`http://169.254.169.254/\` because a caller typed it.
- Prompts, captions or card numbers turn up in the log search tool, readable by everyone on call.
- A signed link shared once still works a week later, or works for a different object when a query
  parameter is edited.

The debugging courses plant these in their first and last steps, where requests enter and records
leave. Some to practise on:

- [Vector Search Service, step 1](/vector-search/1-endpoint): the starter lets the body name the
  tenant and the index version, and adjusts an out-of-range \`k\` instead of telling the caller.
- [Recommendation Ranking, step 1](/recommendation-ranking/1-endpoint): the user whose list is
  ranked can be chosen by the caller, and the candidate list has no size at either end.
- [Embedding Service, step 1](/embedding-service/1-endpoint): one request buys unbounded model work,
  and an oversized input is quietly embedded as a different text.
- [LLM Gateway, step 1](/ai-gateway/1-chat-endpoint): a request that is malformed still costs a
  provider call, and the conversation ends up somewhere it should not.
- [Crawl & Index, step 1](/crawl-index/1-endpoint): the starter does network work before it has
  decided whether the target is allowed at all.
- [PII Redactor, step 5](/pii-redactor/5-read): the audit read loads a record by id alone, and its
  answer carries more than an auditor needs.
- [Multimodal Ingest, step 5](/multimodal-ingest/5-read): the signed link lives too long, does not
  cover everything a caller could edit, and the read ships bytes it should only point to.
- [Moderation Service, step 5](/moderation-service/5-read): the case file shows every field it
  stores to every moderator, as stored.

# Identity comes from the credential

The service sits behind something that authenticated the caller: an API gateway that validated the
key and set \`X-Tenant-Id\`, a bearer token the service verifies, a session. That is the only place
identity may come from. Anything in the body, the query string or a path segment is a **claim**,
and the server checks a claim against the identity; it never adopts it.

Three variants recur:

- **The body names the tenant or user.** Ignore it, or refuse a mismatch with **403** so a client bug
  surfaces instead of hiding. Courses differ on which; both are safe, adopting it is not.
- **The path names a scope** (\`/v1/tenants/{tenant}/spend\`, \`/v1/quotas/{team}\`). The path is a
  claim too: compare it with the credential and refuse a different one.
- **The body carries a decision** the server owns: a role, a priority band, a verdict, an
  eligibility flag, a merge decision, a budget. The server derives these from its own tables.

In FastAPI the identity is a dependency every route takes, so no handler parses it twice:

\`\`\`python
from fastapi import Depends, FastAPI, Header, HTTPException

app = FastAPI()

def tenant_of(x_tenant_id: str | None = Header(default=None)) -> str:
    if not x_tenant_id:
        raise HTTPException(status_code=401, detail="missing tenant")
    return x_tenant_id

@app.post("/v1/search")
def search(body: SearchBody, tenant: str = Depends(tenant_of)):
    if body.tenant is not None and body.tenant != tenant:
        raise HTTPException(status_code=403, detail="tenant mismatch")
    return corpus.nearest(tenant, corpus.active_index(), body.query, body.k)
\`\`\`

In Fastify the same idea is a \`preHandler\` hook that decorates the request, so the handler reads
\`request.tenant\` and has no other source to reach for:

\`\`\`typescript
app.decorateRequest('tenant', '');
app.addHook('preHandler', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing tenant'});
  request.tenant = tenant;
});
\`\`\`

:::details Why "compare the body with the header" is not the whole fix
OWASP's API1:2023 (Broken Object Level Authorization) makes the point directly: comparing the
session's user id with an id parameter only covers a small subset of cases. The id that matters is
often not a user id at all: a document, a case, a run, a storage key. Identity tells you **who**;
each object still needs its own check that this who may act on it. That is the next section.
:::

# A foreign record is a missing record

Object-level authorization fails when a handler loads by the id the caller sent and returns
whatever comes back. The fix is to make the tenant part of the lookup, so a foreign record is
simply not found:

\`\`\`go
func (s *Server) getAsset(w http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(w, \`{"error":"unauthenticated"}\`, http.StatusUnauthorized)
		return
	}
	asset, ok := s.assets.Get(r.PathValue("id"))
	if !ok || asset.Tenant != tenant {
		// One branch, one body: a foreign asset and a missing one look the same.
		http.Error(w, \`{"error":"not_found"}\`, http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, viewOf(asset))
}
\`\`\`

Better still, when the store allows it, key the lookup by the scope (\`assets.Get(tenant, id)\`, a
Redis key that starts with the tenant, a SQL \`WHERE tenant_id = $1 AND id = $2\`), so no code path
holds a foreign record at all. The IDOR cheat sheet's Rails example is the same idea:
\`current_user.projects.find(id)\` instead of \`Project.find(id)\`.

Why **404** and not **403**? RFC 9110 defines 404 as "did not find a current representation for the
target resource **or is not willing to disclose that one exists**", and says a server that wants to
hide a forbidden resource's existence may answer 404 instead of 403. A 403 for foreign ids and a
404 for unknown ones is an oracle: it confirms the id exists. The two answers must match in status
**and** body; a different error string or a missing field gives the game away just as well.

403 still has its place: the caller is known, the resource's existence is not secret, and the
caller lacks a permission (a role outside the reviewer set, a write scope, a private calendar the
course decides to acknowledge). Pick per resource and stay consistent.

:::quiz
Q: \`GET /v1/runs/{id}\` answers 404 for an unknown id and 403 for another tenant's run. Both bodies are \`{"error": "..."}\`. What does an attacker learn?
- [ ] Nothing, because both are errors and neither returns the run
- [ ] Only the run's owner, which is harmless
- [x] Which run ids exist across all tenants, one probe each
- [ ] Nothing, as long as run ids are UUIDs
> The status alone separates "exists, not yours" from "does not exist". Unguessable ids raise the cost but the ids leak in logs, links and referrers, and the oracle still confirms each one. A foreign record answers exactly like a missing one.
:::

# Admission: every limit before any work

A request earns work only after every check passes. The order is fixed:

1. **Authenticate**: no identity, **401**, nothing read.
2. **Shape**: content type (**415** for one outside the allowlist), JSON that parses, required fields
   (**400**).
3. **Size**: bytes of the body and of each field, element counts of each array (**413** or **400**,
   whichever the API documents).
4. **Values**: ranges, enums, allowlists, cross-field rules (**400** or **422** when the content
   is well-formed but cannot be processed).
5. **Authorization of the object**: the referenced record, storage key or host is the caller's to use
   (**404**/**403**).
6. Only then: the write, the fetch, the RPC, the model call, the queue.

The starters break this in two ways. They **reorder** it: the provider is called, the object is read
or the URL is fetched, and validation runs on the result. Or they **soften** it: a value out of range
is clamped, an input over the cap is cut, and the caller gets a 200 for a request the service did
not perform. A clamped \`k\` means a client asking for 500 results believes it has seen everything;
a truncated input means the stored embedding is of a text nobody sent. Refuse with a status that
names the limit, and let the client decide.

:::sequence
{
  "participants": ["Caller", "crawler", "Network"],
  "messages": [
    {"from": "Caller", "to": "crawler", "label": "POST /v1/crawl/targets {url: http://169.254.169.254/latest}", "kind": "sync"},
    {"from": "crawler", "to": "Network", "label": "fetch_page(url)  ← work before the decision", "kind": "sync"},
    {"from": "Network", "to": "crawler", "label": "cloud metadata, credentials", "kind": "reply"},
    {"from": "crawler", "to": "crawler", "label": "host not in ALLOWED_HOSTS → 400", "kind": "sync"},
    {"from": "crawler", "to": "Caller", "label": "400, but the request already happened", "kind": "reply"}
  ]
}
:::

A refusal that comes after the side effect is not a refusal. The same shape appears as a provider
call billed for a request that then fails validation, a storage object read before the 403 on its
key, or a job row written before its fields are checked.

## Bytes, not characters

Limits protect columns, buffers, token budgets and downstream caps, all of which count **bytes**.
A 4 KiB cap measured in characters admits 16 KiB of CJK text or emoji. Each stack has its own trap:

| Stack | Bytes of a string | Characters (the trap) |
| --- | --- | --- |
| Python | \`len(text.encode("utf-8"))\` | \`len(text)\` |
| TypeScript | \`Buffer.byteLength(text, 'utf8')\` | \`text.length\` (UTF-16 code units) |
| Go | \`len(text)\` | \`utf8.RuneCountInString(text)\` |
| C++ | \`text.size()\` on a UTF-8 \`std::string\` | a count of decoded code points |

Cap the whole body at the transport too, so the server never buffers an unbounded request before
the handler runs. In Go:

\`\`\`go
r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		http.Error(w, \`{"error":"too_large"}\`, http.StatusRequestEntityTooLarge)
		return
	}
	http.Error(w, \`{"error":"bad_json"}\`, http.StatusBadRequest)
	return
}
\`\`\`

Fastify has \`bodyLimit\` on the server or the route, and answers **413** itself when it is exceeded;
FastAPI has no body limit of its own, so the per-field byte check in the handler (or a limit at the
proxy in front) is the guard.

:::details OWASP's list of limits an API forgets
API4:2023 (Unrestricted Resource Consumption) lists what goes missing: execution timeouts, memory,
upload size, the number of operations in one request (batching), records per page, and spending
limits at paid third parties. Its prevention list asks for a maximum on every incoming string length
and array size, and server-side validation of the parameter that controls how many records come
back. Every one maps to a check in this section: a batch cap, a page-size cap, a byte cap, and a
refusal before the paid call.
:::

:::quiz
Q: A field is capped at "8 KiB". The starter checks \`len(text) > 8192\` in Python and cuts longer text with \`text[:8192]\`. Which pair of flaws does it hide?
- [ ] None: Python strings are UTF-8, so length is bytes
- [x] A multi-byte text passes the check at up to four times the cap, and an oversized one is stored as a different text instead of refused
- [ ] Only the truncation; the length check is right for ASCII callers
- [ ] The cap should be 8000, since KiB is ambiguous
> \`len\` counts code points, not bytes, so \`"é" * 8000\` is 16,000 bytes and passes. Cutting turns a refusal into a silent rewrite of the caller's data. Measure \`len(text.encode("utf-8"))\` and answer 413 without touching the text.
:::

# Egress: what responses and logs may carry

The last boundary is the way out. A handler that serializes the stored record, or logs the request
body to help debugging, publishes everything the record holds to everyone who can read the
response or the log.

- **Project, do not dump.** Build the response from a view type with the fields this caller may see.
  A customer view and an operations view are two projections; the role that picks one comes from the
  credential, never from a query parameter.
- **Echo nothing.** A **413** says what the limit is, not what the text was. An error for a refused
  prompt names the rule, not the prompt.
- **Escape on the way out** for the context the text lands in (HTML for a console, nothing for JSON
  consumed by code). Escape before you shorten, or count the cap on the escaped form, so an entity
  is never cut in half.
- **Mask in the response builder**, not at the client: \`**** 4242\`, a fingerprint instead of key
  material. No header or flag should switch masking off; raw values go through a separate, audited
  read.
- **Point, do not carry.** Large or sensitive bytes go out as a signed link that expires in minutes,
  not as base64 in the JSON.
- **Log ids, sizes, decisions.** The OWASP Logging Cheat Sheet lists what should usually be removed,
  masked, hashed or encrypted before it is recorded: session ids, access tokens, sensitive personal
  data, passwords, keys, payment card data. A prompt, a transcript or a caption belongs on that list.

A signed link is only as narrow as what the signature covers. Sign every part a caller could edit,
together, with the expiry inside the signature:

\`\`\`typescript
import {createHmac, timingSafeEqual} from 'node:crypto';

const sign = (tenant: string, checksum: string, expiresAt: number): string =>
  createHmac('sha256', SIGNING_KEY).update([tenant, checksum, String(expiresAt)].join('|')).digest('hex');

export function verifyLink(tenant: string, checksum: string, expiresAt: number, mac: string, now: number): boolean {
  if (now >= expiresAt) return false;
  const expected = Buffer.from(sign(tenant, checksum, expiresAt), 'hex');
  const given = Buffer.from(mac, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
\`\`\`

A signature over the checksum alone lets the tenant be swapped; one without the expiry lets the
expiry be pushed out; a TTL of days turns every leaked link into a long-lived credential.

:::quiz
Q: A redaction service logs \`"redact request tenant=%s body=%s"\` at INFO to debug a customer issue. The response itself is redacted correctly. What is the problem?
- [ ] None: logs are internal
- [ ] Only that INFO is too verbose; DEBUG would be fine
- [x] The log now holds the unredacted text the service exists to remove, readable by anyone with log access and kept for the log's retention
- [ ] The tenant should not be logged
> Logs have wider readership and longer retention than the data store, and are rarely covered by the same deletion rules. Log the request id, the tenant, sizes, counts and the decision; never the content. The tenant id is fine: it is an identifier, not the customer's data.
:::

# The fix, as a pattern

A handler that holds all four boundaries reads top to bottom in the same order every time:

\`\`\`python
@app.post("/v1/embeddings")
def embed(body: EmbedBody, tenant: str = Depends(tenant_of)):
    if not 1 <= len(body.inputs) <= MAX_BATCH:                          # admission: count
        raise HTTPException(400, {"error": "batch_size", "max": MAX_BATCH})
    for i, text in enumerate(body.inputs):                              # admission: bytes
        if len(text.encode("utf-8")) > MAX_INPUT_BYTES:
            raise HTTPException(413, {"error": "input_too_large", "index": i, "max_bytes": MAX_INPUT_BYTES})
    vectors = [embedder.embed(t, MODEL_VERSION) for t in body.inputs]  # work, only now
    log.info("embedded tenant=%s inputs=%d", tenant, len(body.inputs))  # egress: ids and sizes
    return {"model_version": MODEL_VERSION, "vectors": vectors}
\`\`\`

Trade-offs and choices:

- **403 on a mismatched body field, or ignore it?** Ignoring is simplest and safe. Refusing catches
  client bugs early and is what several courses ask for. Adopting the body is never an option.
- **400 versus 422.** Use 400 for a request that is malformed and 422 for one that parses but makes
  no sense (an end before a start, a coordinate off the planet). Follow the API's documented choice;
  consistency matters more than the split.
- **Name the limit, not the value.** \`{"error": "input_too_large", "max_bytes": 8192}\` helps a client
  fix itself without echoing anything back.
- **Centralize identity, not validation.** A shared dependency or hook for the credential prevents
  drift. Validation stays beside each route, where its limits are documented.

What not to do:

- Do not clamp, cut, default or "fix up" an invalid value and answer 200.
- Do not filter results by tenant **after** loading them; scope the lookup itself.
- Do not rely on unguessable ids instead of a check. They are defence in depth, not authorization.
- Do not make the refusal path cheaper to observe than the success path in ways that leak (different
  bodies, different headers, a timing gap from an extra lookup only foreign ids take).
- Do not add a debug flag, header or query parameter that unlocks raw content.

Once the request is admitted, other guides take over: a retried admission is
[idempotent requests](/guides/idempotent-requests), the cache keys that must carry the same tenant
are [keys and expiry](/guides/keys-and-expiry), reads that must stay scoped and honest are
[honest reads](/guides/honest-reads), and text that will reach a model is
[model output](/guides/model-output).

# Proving the fix

The course harnesses never test that a handler "reads the header". They test outcomes a caller
can observe, from two tenants, with spies on everything expensive. Each test below fails on a
typical starter and passes on the fix.

**Two tenants, one id.** Seed a record for \`acme\`, then ask as \`globex\`, and ask for an id nobody
has. The two answers must be identical:

\`\`\`python
def test_foreign_record_is_a_missing_record(client, store):
    store.put(Asset(id="a1", tenant="acme", caption="private"))
    foreign = client.get("/v1/assets/a1", headers={"X-Tenant-Id": "globex"})
    missing = client.get("/v1/assets/zz", headers={"X-Tenant-Id": "globex"})
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert "private" not in foreign.text
\`\`\`

**The body cannot pick the tenant.** Send \`X-Tenant-Id: globex\` with \`{"tenant": "acme"}\` and
assert the answer holds none of acme's data (and is 403, if the API refuses mismatches).

**Refusals cost nothing.** Wrap every dependency (provider, store, fetcher, queue) in a spy, send
each invalid request, and assert both the status and that the spies saw **zero** calls:

\`\`\`python
@pytest.mark.parametrize("body,status", [
    ({"inputs": []}, 400),
    ({"inputs": ["x"] * (MAX_BATCH + 1)}, 400),
    ({"inputs": ["é" * (MAX_INPUT_BYTES // 2 + 1)]}, 413),  # under the cap in characters, over it in bytes
])
def test_refused_before_any_work(client, embedder_spy, body, status):
    r = client.post("/v1/embeddings", json=body, headers={"X-Tenant-Id": "acme"})
    assert r.status_code == status
    assert embedder_spy.calls == []
\`\`\`

The multi-byte case is the one that separates a byte check from a character check; an ASCII-only
test passes both. Add one exactly at the cap (accepted) and one byte over (refused) to pin the
boundary.

**Nothing leaks out.** Capture the logs (\`caplog\` in pytest, a stream logger in the other stacks),
send a request whose content is a unique marker such as \`"canary-7f3a"\`, and assert the marker
appears in no log line and in no error body. For signed links, move the clock: the link verifies at
\`expires_at - 1\` and fails at \`expires_at\`; then edit each signed field in turn (tenant, checksum,
expiry) and assert each edit fails verification.

:::details Why the tests run against the starter first
A test that passes on the fixed handler proves little unless it also failed on the starter. The
debugging courses check both: the starter must fail each check it names, and the fix must pass it.
When you write your own, run it against the unfixed code once and watch it go red for the right
reason. OWASP's IDOR cheat sheet frames the same habit for authorization: create two users, give
each objects, and as one try every operation on the other's objects (read, update, delete, export),
whether the ids are predictable or not.
:::
`;

export const sources: Source[] = [
  {
    title: 'API1:2023 Broken Object Level Authorization',
    url: 'https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/',
    kind: 'docs',
    venue: 'OWASP API Security Top 10',
    by: 'OWASP API Security Project team',
    takes:
      'That every endpoint taking an object id needs an object-level check, and that comparing the session user with an id parameter covers only a small subset of cases.',
  },
  {
    title: 'API4:2023 Unrestricted Resource Consumption',
    url: 'https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/',
    kind: 'docs',
    venue: 'OWASP API Security Top 10',
    by: 'OWASP API Security Project team',
    takes:
      'The list of limits an API forgets (upload size, operations per request, records per page, spending at paid providers) behind the admission section.',
  },
  {
    title: 'Insecure Direct Object Reference Prevention Cheat Sheet',
    url: 'https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html',
    kind: 'docs',
    venue: 'OWASP Cheat Sheet Series',
    takes:
      'Scoping the lookup to what the user may access instead of loading by id, and the two-user test for every operation on an object reference.',
  },
  {
    title: 'RFC 9110: HTTP Semantics',
    url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
    kind: 'docs',
    venue: 'IETF',
    by: 'R. Fielding, M. Nottingham, J. Reschke (eds.)',
    date: '2022-06',
    takes:
      'The meaning of 401, 403, 413, 415 and 422, and that a server may answer 404 to avoid disclosing that a forbidden resource exists.',
  },
  {
    title: 'Logging Cheat Sheet',
    url: 'https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html',
    kind: 'docs',
    venue: 'OWASP Cheat Sheet Series',
    takes:
      'The data that should be removed, masked, hashed or encrypted before it reaches a log: session ids, tokens, sensitive personal data, keys and card data.',
  },
];
