/**
 * The learning guide for the gRPC metadata-auth drill: credentials in metadata, UNAUTHENTICATED
 * against PERMISSION_DENIED, why the gates run before validation and lookup (the existence oracle),
 * and where production services put the check. Rendered at `/grpc-metadata-auth/learn`.
 */
export const learn = `# The mechanism at a glance

A gRPC service that holds anything private has to answer two questions on every call before it does any
work: **who is calling**, and **may they do this**. The caller's credentials do not travel in the request
message; they travel in **metadata**, the key/value pairs that ride beside every call as HTTP/2 headers.
The service reads them, decides, and only then looks at the request.

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Callers", "sub": "authorization: Bearer <token>", "x": 22, "y": 50},
    {"id": "notes", "kind": "grpc", "label": "notes.v1.Notes", "sub": "authenticate · authorize · validate · look up", "x": 70, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "notes", "kind": "grpc", "label": "GetNote · DeleteNote + metadata"}
  ]
}
:::

The contract the drill implements:

- Two unary RPCs: \`GetNote(GetNoteRequest{id}) → Note{id, text}\` and
  \`DeleteNote(DeleteNoteRequest{id}) → DeleteNoteResponse{deleted}\`, over a module-level store \`NOTES\`.
- Credentials come from the metadata key \`authorization\`, as \`Bearer <token>\`. \`TOKENS\` maps
  \`reader-7f3a\` to \`notes.read\` and \`admin-91c2\` to \`notes.read\` and \`notes.write\`.
- \`GetNote\` needs \`notes.read\`; \`DeleteNote\` needs \`notes.write\`.
- Four gates, in order: missing, malformed or unknown credentials are \`UNAUTHENTICATED\`; a known token
  without the scope is \`PERMISSION_DENIED\`; an empty id is \`INVALID_ARGUMENT\`; a missing note is
  \`NOT_FOUND\`.

# Who you are, and what you may do

Authentication and authorization are different questions with different answers, and gRPC gives each its
own [status code](https://grpc.github.io/grpc/core/md_doc_statuscodes.html):

| Question | Fails when | gRPC status | HTTP cousin | What the client should do |
|---|---|---|---|---|
| Who are you? (authentication) | no credentials, a malformed header, an unknown or expired token | \`UNAUTHENTICATED\` (16) | 401 | get new credentials (log in, refresh the token), then retry |
| May you do this? (authorization) | a known identity lacks the permission | \`PERMISSION_DENIED\` (7) | 403 | stop: retrying with the same identity cannot succeed |

- The gRPC spec is explicit: \`PERMISSION_DENIED\` must not be used when the caller cannot be identified;
  that case is \`UNAUTHENTICATED\`. A \`PERMISSION_DENIED\` is a statement about a *known* caller.
- The split drives client behaviour. A client library that sees \`UNAUTHENTICATED\` can refresh its token
  once and retry; one that sees \`PERMISSION_DENIED\` should surface the error to a person, because a fresh
  token for the same identity carries the same permissions.
- Scopes make authorization a set lookup: the token grants \`{"notes.read"}\`, the RPC needs
  \`notes.write\`, the answer is no. Real systems add roles, resource ownership and policy engines, but the
  shape stays: identity first, then a decision about this identity and this action.

The HTTP side of the same split, with 401 and 403 among the codes a service actually uses:

:::widget status-codes {}

:::quiz
Q: The reader token \`reader-7f3a\` calls \`DeleteNote\`. Which status is right?
- [ ] \`UNAUTHENTICATED\`, because the call is not allowed
- [x] \`PERMISSION_DENIED\`, because the token is valid and only lacks \`notes.write\`
- [ ] \`NOT_FOUND\`, so the reader cannot tell the note exists
> The service knows exactly who is calling, so authentication succeeded. What failed is the permission check, and that is \`PERMISSION_DENIED\`. Answering \`UNAUTHENTICATED\` would send a well-behaved client off to refresh a token that is perfectly fine.
:::

# Metadata, not message fields

Every gRPC call is an HTTP/2 request. Metadata is that request's headers; the message is its body:

\`\`\`text
:method: POST
:path: /notes.v1.Notes/DeleteNote
content-type: application/grpc
authorization: Bearer admin-91c2      <- metadata: about the call
grpc-timeout: 2S
                                      <- body: the length-prefixed DeleteNoteRequest{id: "n-1"}
\`\`\`

Why credentials belong up there and not in a \`token\` field of each request:

- **One check for every RPC.** A field would have to be added to every request type, and every handler
  would have to remember it. A header is the same for \`GetNote\`, \`DeleteNote\` and any RPC added next year,
  so one piece of code can judge them all without knowing the message types.
- **The infrastructure can see it.** Proxies, sidecars and gateways read headers without parsing protobuf.
  Envoy can reject a bad token before the call reaches the service at all.
- **Client libraries attach it for you.** gRPC's *call credentials* (an access-token or OAuth credential
  object) put \`authorization\` on every outgoing call; application code never touches it. See the
  [gRPC authentication guide](https://grpc.io/docs/guides/auth/).
- **It follows the HTTP convention.** \`Bearer <token>\` is the scheme of
  [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750#section-2.1), so a token minted for a REST API works
  unchanged against a gRPC one.

The rules of [metadata](https://grpc.io/docs/guides/metadata/) that matter here: keys are lowercase
ASCII (\`authorization\`, never \`Authorization\` on the wire), a key ending in \`-bin\` carries binary values,
the \`grpc-\` prefix is reserved, and a key may repeat. The drill reads the first \`authorization\` value
and insists on the exact \`Bearer \` prefix; a bare token, \`Basic …\`, or the right value under another key
are all \`UNAUTHENTICATED\`.

:::details What about the TLS layer?
Metadata tokens prove who the *caller* is at the application level. Mutual TLS proves which *workload* is
on the other end of the connection, from its certificate, before any header is read. Service meshes
usually do both: mTLS between sidecars for service identity, a bearer token in metadata for the end user
on whose behalf the call is made. This drill models only the token.
:::

:::quiz
Q: Why put the token in \`authorization\` metadata instead of a \`string token\` field on each request message?
- [ ] Metadata is encrypted and message fields are not
- [x] One piece of code can check every RPC, and proxies can read it, without knowing any message type
- [ ] Message fields cannot hold strings longer than 64 bytes
> Both travel over the same (TLS-protected) connection, so neither is more secret. The difference is where they sit: a header is uniform across every RPC and visible to infrastructure, while a field has to be added, parsed and checked per message type.
:::

# Why the order matters: the existence oracle

Each gate's answer carries information, and the order decides who gets to hear it. Put the lookup first
and an anonymous caller can map the id space for free:

:::sequence
{
  "participants": ["anonymous", "Notes (lookup first)"],
  "messages": [
    {"from": "anonymous", "to": "Notes (lookup first)", "label": "GetNote{n-1} · no authorization", "kind": "sync"},
    {"from": "Notes (lookup first)", "to": "anonymous", "label": "UNAUTHENTICATED (the note exists)", "kind": "reply"},
    {"from": "anonymous", "to": "Notes (lookup first)", "label": "GetNote{n-9} · no authorization", "kind": "sync"},
    {"from": "Notes (lookup first)", "to": "anonymous", "label": "NOT_FOUND (it does not)", "kind": "reply"},
    {"from": "anonymous", "to": "Notes (lookup first)", "label": "GetNote{n-2}, {n-3}, … one probe per id", "kind": "sync"},
    {"from": "Notes (lookup first)", "to": "anonymous", "label": "every existing id, without a credential", "kind": "reply"}
  ]
}
:::

The contents stayed hidden, but the set of ids did not, and ids leak a lot: how many customers there
are, whether a given account exists, when a document was created (if ids are sequential or time-based).
With the gates in order, every probe gets the same answer:

:::sequence
{
  "participants": ["anonymous", "Notes", "reader"],
  "messages": [
    {"from": "anonymous", "to": "Notes", "label": "GetNote{n-1} · no authorization", "kind": "sync"},
    {"from": "Notes", "to": "anonymous", "label": "UNAUTHENTICATED", "kind": "reply"},
    {"from": "anonymous", "to": "Notes", "label": "GetNote{n-9} · no authorization", "kind": "sync"},
    {"from": "Notes", "to": "anonymous", "label": "UNAUTHENTICATED (same code, same details)", "kind": "reply"},
    {"from": "reader", "to": "Notes", "label": "DeleteNote{n-9} · Bearer reader-7f3a", "kind": "sync"},
    {"from": "Notes", "to": "reader", "label": "PERMISSION_DENIED (still not NOT_FOUND)", "kind": "reply"}
  ]
}
:::

| Gate | Runs only after | Reveals to the caller |
|---|---|---|
| authenticate | nothing | whether the credential is valid |
| authorize | a known identity | whether this identity holds the scope |
| validate | permission | whether the request is well formed |
| look up | a valid request | whether the note exists |

- The same holds for validation: \`INVALID_ARGUMENT\` before \`UNAUTHENTICATED\` tells an anonymous caller
  what a well-formed request looks like. Cheap, but not theirs to learn.
- Fixed error details matter as much as the code. \`UNAUTHENTICATED: no note n-9\` leaks the same bit as
  \`NOT_FOUND\` would.
- Ordering is also cheaper: rejecting a bad token costs a dictionary lookup, while a lookup against a real
  database costs a query. Unauthenticated traffic should never reach the expensive part.
- Google's [AIP-211](https://google.aip.dev/211) writes the rule down for its APIs: permission is checked
  before existence, and a caller without permission gets \`PERMISSION_DENIED\` whether or not the resource
  exists. Some APIs go further and answer \`NOT_FOUND\` to a known caller who may not see a resource (GitHub
  does this for private repositories), so not even signed-in users learn what exists outside their reach.
  The drill keeps \`PERMISSION_DENIED\` because its scopes are per action, not per note.

:::details The same leak through the clock
Identical codes and details are not the whole story: response time can leak too. A server that looks the
note up before checking the token takes a little longer for ids that exist (a cache hit, a row read),
and an attacker with enough samples can see the difference even when every answer says
\`UNAUTHENTICATED\`. Gating first removes that path as well, because a rejected call never touches the
store. The token comparison has the mirror problem: comparing the presented token to a stored secret byte
by byte returns sooner the earlier they differ, which is why real services compare secrets in constant
time (\`hmac.compare_digest\` in Python, \`crypto.timingSafeEqual\` in Node) or compare hashes instead.
:::

:::quiz
Q: A handler checks that the note exists, and only then checks the token. Every response code is still correct for a legitimate caller. What is wrong?
- [ ] Nothing, as long as the note's text is never returned without a token
- [x] Anyone can learn which ids exist by comparing \`NOT_FOUND\` with \`UNAUTHENTICATED\`
- [ ] The handler will return \`PERMISSION_DENIED\` for anonymous callers
> The answers differ by whether the note exists, so the status code itself is the leak. Authenticating first makes every anonymous probe look the same, whatever the id.
:::

# Where real systems do this: interceptors

In the drill both handlers open with the same helper call. Production services lift that call out of the
handlers into a **server interceptor**: code the gRPC server runs around every call, before the handler,
with access to the metadata and the method name.

\`\`\`go
func auth(ctx context.Context, req any, info *grpc.UnaryServerInfo, next grpc.UnaryHandler) (any, error) {
	scope := scopeFor[info.FullMethod] // "/notes.v1.Notes/DeleteNote" -> "notes.write"
	if err := authorize(ctx, scope); err != nil {
		return nil, err // the handler never runs
	}
	return next(ctx, req)
}

srv := grpc.NewServer(grpc.UnaryInterceptor(auth))
\`\`\`

- **No handler can forget.** A new RPC is protected the moment it is registered, as long as the table of
  scopes covers it; a good interceptor rejects any method missing from the table (fail closed).
- **The identity travels on.** The interceptor puts the verified caller into the call's context, so the
  handler can log it or check ownership without parsing the header again. In grpc-java that is a
  \`Context.Key\`; in Go a \`context.WithValue\`; in Python grpcio a \`grpc.aio.ServerInterceptor\`.
- **Or outside the process.** Envoy's external authorization filter, an API gateway or a service-mesh
  policy can make the same decision before the call reaches the service at all. The service then trusts
  a header the sidecar sets, which is only safe if nothing else can reach it.

The order inside an interceptor chain matters for the same reason as in the drill: authentication first,
then authorization, then anything that inspects the request (validation, rate limits keyed by caller).
This drill's runtime does not run server interceptors, which is why the check lives in a helper the
handlers call first; the property being tested is the same.

:::quiz
Q: You add a third RPC, \`ShareNote\`, and forget to add it to the interceptor's method-to-scope table. What should happen to calls to it?
- [ ] They run unauthenticated, since no scope is required
- [ ] They get \`PERMISSION_DENIED\` only for the reader token
- [x] They are rejected, because an unknown method is denied by default
> Failing closed turns a forgotten table entry into a loud bug in testing rather than an open endpoint in production. An interceptor that lets unknown methods through has moved the "remember to check" problem rather than solved it.
:::

# What to take away

- Credentials ride in metadata (\`authorization: Bearer <token>\`), beside the message, so one check can
  guard every RPC and infrastructure can read it.
- \`UNAUTHENTICATED\` means "I do not know who you are"; \`PERMISSION_DENIED\` means "I know you, and no".
  Clients refresh on the first and give up on the second.
- Gate in order: authenticate, authorize, validate, look up. Every answer leaks something, and only a
  caller who passed the earlier gates may learn the later ones.
- An auth failure answers the same, code and details, whatever the request asked for.
- Production services put the check in a server interceptor or a sidecar that fails closed on unknown
  methods, and verify signed tokens rather than looking them up in a table.

Primary reference: [gRPC authentication guide](https://grpc.io/docs/guides/auth/).
`;
