/**
 * The learning guide for the CORS drill: simple versus preflighted requests, why credentials forbid
 * `*`, Vary and shared caches, Max-Age, the reflect-any-origin bug, and why CORS is not CSRF
 * protection. Rendered at `/http-cors-preflight/learn`.
 */
export const learn = `# The mechanism at a glance

A browser keeps every origin's scripts apart: a page on \`https://app.example.com\` may *send* a request to
another origin, but it may not *read* the response unless that origin says so. **CORS** (cross-origin
resource sharing) is how it says so: \`Access-Control-*\` response headers that the browser checks before
it hands the response to the script. The server declares, the browser enforces.

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Browser", "sub": "page on https://app.example.com · allowed", "x": 20, "y": 30},
    {"id": "external", "kind": "external", "label": "Other site", "sub": "page on https://evil.example.com · not allowed", "x": 20, "y": 75},
    {"id": "notes", "kind": "service", "label": "notes API", "sub": "answers preflights · declares grants · Vary", "x": 70, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "notes", "kind": "http", "label": "OPTIONS → 204 grant, then the real request"},
    {"from": "external", "to": "notes", "kind": "http", "label": "OPTIONS → 403, no Access-Control-*"}
  ]
}
:::

The contract the drill implements on every \`/api/...\` path:

- \`ALLOWED_ORIGINS = {"https://app.example.com", "https://admin.example.com"}\`, methods \`GET, POST, DELETE\`,
  \`ALLOWED_HEADERS = {"authorization", "content-type"}\`, \`MAX_AGE = 600\`.
- A **preflight** is \`OPTIONS\` with \`Origin\` and \`Access-Control-Request-Method\`. Allowed (origin, method
  and every requested header on the lists) → **204**, empty body, \`Access-Control-Allow-Origin: <origin>\`,
  \`Access-Control-Allow-Methods: GET, POST, DELETE\`, \`Access-Control-Allow-Headers\` (the requested names,
  lowercased; omitted when none), \`Access-Control-Allow-Credentials: true\`, \`Access-Control-Max-Age: 600\`,
  \`Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers\`. Anything else → **403**
  with no \`Access-Control-*\` header.
- An **actual request** always gets \`Vary: Origin\`. An allowed \`Origin\` also gets
  \`Access-Control-Allow-Origin: <origin>\` and \`Access-Control-Allow-Credentials: true\`. Never \`*\`. Any
  other \`Origin\`, or none, gets the normal response with no grant.

# Simple requests and preflighted requests

The web had cross-origin form posts long before CORS, so CORS does not ask permission for what a form
could already do. A request is **simple** when it looks like one:

| Part | Simple only if |
|---|---|
| Method | \`GET\`, \`HEAD\` or \`POST\` |
| Headers set by the script | only the safelisted ones: \`Accept\`, \`Accept-Language\`, \`Content-Language\`, \`Content-Type\` |
| \`Content-Type\` | \`application/x-www-form-urlencoded\`, \`multipart/form-data\` or \`text/plain\` |

A simple request goes straight out, and CORS only decides whether the script may read the answer.
Anything else is **preflighted**: before sending it the browser asks, with an \`OPTIONS\` request that
names the method and the non-safelisted headers it wants to use. A JSON \`POST\` is not simple
(\`Content-Type: application/json\`), an \`Authorization\` header is not simple, and a \`DELETE\` is never
simple, so almost every call a single-page app makes to its API is preflighted.

:::sequence
{
  "participants": ["page on app.example.com", "Browser", "notes API"],
  "messages": [
    {"from": "page on app.example.com", "to": "Browser", "label": "fetch POST, JSON, with cookies", "kind": "sync"},
    {"from": "Browser", "to": "notes API", "label": "OPTIONS · ACR-Method: POST · ACR-Headers: content-type", "kind": "sync"},
    {"from": "notes API", "to": "Browser", "label": "204 · grant · Max-Age: 600", "kind": "reply"},
    {"from": "Browser", "to": "notes API", "label": "POST /api/notes · Origin · Cookie", "kind": "sync"},
    {"from": "notes API", "to": "Browser", "label": "201 · Allow-Origin · Vary: Origin", "kind": "reply"},
    {"from": "Browser", "to": "page on app.example.com", "label": "response readable", "kind": "reply"}
  ]
}
:::

What makes a preflight easy to get wrong on the server:

- **It reaches no route.** Most frameworks route by method and nobody declared \`OPTIONS /api/notes\`.
  FastAPI answers 405 and a strict router answers 404, both of which the browser reads as "no". The CORS
  layer has to see the preflight before routing and answer it itself.
- **It carries no cookies.** The preflight is sent without credentials, so it cannot be authenticated and
  must not need to be. It is a question about the API's policy, not about the user.
- **A refusal is opaque to the page.** A 403 preflight fails the \`fetch\` with a network error; the script
  never sees a status, which is the point. The real request is never sent.
- **The real request still gets headers.** Passing the preflight is not enough: the actual response must
  carry \`Access-Control-Allow-Origin\` again, or the browser withholds it.

:::quiz
Q: A page on an allowed origin sends fetch('/api/notes', {method: 'POST', body: JSON.stringify(n), headers: {'Content-Type': 'application/json'}}). What reaches the server first?
- [ ] The POST, with the CORS check applied to its response
- [x] An OPTIONS preflight naming POST and content-type; the POST follows only if it is granted
- [ ] Nothing: a JSON POST across origins is blocked outright
> application/json is not one of the three form content types, so the request is not simple. The browser asks first with OPTIONS, and sends the POST only after a grant that covers the method and the content-type header.
:::

# Credentials and the wildcard origin

\`Access-Control-Allow-Origin: *\` means "any origin may read this". That is right for a public, anonymous
resource such as a font or an open data feed. It is never right for a response computed from a user's
cookies, so the [Fetch standard](https://fetch.spec.whatwg.org/#http-cors-protocol) makes the browser
refuse the combination:

| Request credentials | Response | Browser |
|---|---|---|
| omitted | \`Allow-Origin: *\` | readable |
| omitted | \`Allow-Origin: https://app.example.com\` | readable from that origin only |
| \`include\` | \`Allow-Origin: *\` | **blocked**, even with \`Allow-Credentials: true\` |
| \`include\` | \`Allow-Origin: https://app.example.com\` without \`Allow-Credentials: true\` | **blocked** |
| \`include\` | \`Allow-Origin: https://app.example.com\` and \`Allow-Credentials: true\` | readable from that origin only |

- With credentials the server must name the one origin, so it echoes the request's \`Origin\` after
  finding it in the allowlist. The header takes exactly one origin; a list is invalid.
- \`Access-Control-Allow-Credentials: true\` goes on the preflight answer *and* on the actual response.
  The notes app sends cookies, so the drill sends it on every grant.
- In credentialed mode the browser also stops treating \`*\` as a wildcard in \`Allow-Methods\` and
  \`Allow-Headers\`; it becomes a literal header name. The drill lists methods and echoes header names, so
  the question does not arise.

:::quiz
Q: The API sends Access-Control-Allow-Origin: * and Access-Control-Allow-Credentials: true. The app fetches with credentials: 'include'. What happens?
- [ ] The browser reads it: credentials are allowed and every origin is allowed
- [x] The browser blocks it: a credentialed response must name the origin
- [ ] The browser drops the cookie and retries anonymously
> Fetch forbids * with credentials, because a wildcard that applied to cookie-bearing responses would let every site on the web read every user's data. The server must echo one allowlisted origin.
:::

# Vary and caches

Once the server echoes the origin, the same URL has different responses for different callers: one with
\`Access-Control-Allow-Origin: https://app.example.com\`, one with \`https://admin.example.com\`, one with no
grant at all. A shared cache (a CDN, a corporate proxy) that keys only on the URL will store one of them
and serve it to everyone. [\`Vary\`](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.5) (RFC 9110,
section 12.5.5) tells it which request headers the response depends on:

:::sequence
{
  "participants": ["page on admin.example.com", "CDN", "notes API"],
  "messages": [
    {"from": "CDN", "to": "notes API", "label": "GET /api/notes (a server-side fetch, no Origin)", "kind": "sync"},
    {"from": "notes API", "to": "CDN", "label": "200 · no Allow-Origin · no Vary", "kind": "reply"},
    {"from": "CDN", "to": "CDN", "label": "store under the URL alone", "kind": "sync"},
    {"from": "page on admin.example.com", "to": "CDN", "label": "GET /api/notes · Origin: https://admin.example.com", "kind": "sync"},
    {"from": "CDN", "to": "page on admin.example.com", "label": "cached 200 without Allow-Origin → blocked for an allowed origin", "kind": "reply"}
  ]
}
:::

With \`Vary: Origin\` the cache keys on the URL *and* the \`Origin\` value, and each origin gets the answer
computed for it. Three rules follow:

- **Vary on every response, granted or not.** The response with no grant is the one most likely to be
  cached first (a crawler, a health probe, a server-side fetch), and it is the one that breaks the app
  when served to it. The drill sends \`Vary: Origin\` even when no \`Origin\` came in.
- **The preflight varies on more.** Its answer depends on the method and headers asked for, so it names
  \`Origin, Access-Control-Request-Method, Access-Control-Request-Headers\`. RFC 9110 makes \`OPTIONS\`
  responses uncacheable, so this is for caches that ignore that rule and for the reader of the response;
  the browser's own preflight cache keys on origin and URL by itself.
- **Wrong in the other direction is a leak.** If the API reflected origins and a cache stored the
  response granted to one site, every visitor would get that grant. Vary keeps grants per origin.

:::quiz
Q: GET /api/notes without an Origin header gets 200 with no Access-Control-Allow-Origin. Why must it still say Vary: Origin?
- [ ] It must not; Vary only matters when a grant was made
- [x] A cache could store this ungranted response and serve it to an allowed origin, whose browser would then block it
- [ ] Browsers reject any cross-origin response without Vary
> The response depends on Origin whether or not one was sent. Without Vary a shared cache treats the ungranted answer as the answer for everyone, and the allowed app breaks.
:::

# Max-Age: caching the preflight

Every preflighted call costs an extra round trip before the real one. \`Access-Control-Max-Age\` lets the
browser remember a grant and skip the \`OPTIONS\` for a while:

| \`Access-Control-Max-Age\` | Effect |
|---|---|
| absent | the grant is cached for 5 seconds |
| \`600\` (the drill) | 10 minutes |
| above 7200 | Chromium caps it at 7200 s (2 hours) |
| above 86400 | Firefox caps it at 86400 s (24 hours) |

- The cache is per origin and per **URL**, not per API. A grant for \`/api/notes\` does not cover
  \`/api/notes/7\`; an app that deletes many notes preflights each path once.
- It is also per method and per header name: a grant for \`POST\` with \`content-type\` does not cover a
  later \`DELETE\` with \`authorization\`.
- Longer is cheaper and slower to revoke. Ten minutes means a removed origin keeps working in an open
  tab for up to ten minutes. That bounds how fast an allowlist change takes effect, which is the real
  trade-off behind the number.

:::quiz
Q: The API sends Access-Control-Max-Age: 600. A page preflights POST /api/notes, then 30 seconds later sends DELETE /api/notes/7. Is there a second preflight?
- [x] Yes: the preflight cache is keyed by URL and method, and /api/notes/7 with DELETE was never granted
- [ ] No: the grant covers the whole API for 600 seconds
- [ ] No: DELETE is a simple method and is never preflighted
> A preflight answers for one URL and the methods and headers that were asked about. A different path, or the same path with a method not yet granted, needs its own OPTIONS.
:::

# The reflect-any-origin bug

The tempting shortcut when credentials forbid \`*\` is to copy the request's \`Origin\` into
\`Access-Control-Allow-Origin\` unconditionally. It works for the app, and it is \`*\` with credentials
by another name:

:::sequence
{
  "participants": ["user on evil.example.com", "Browser", "notes API"],
  "messages": [
    {"from": "user on evil.example.com", "to": "Browser", "label": "script: fetch /api/notes, credentials: include", "kind": "sync"},
    {"from": "Browser", "to": "notes API", "label": "GET /api/notes · Origin: https://evil.example.com · Cookie: session", "kind": "sync"},
    {"from": "notes API", "to": "Browser", "label": "200 · the user's notes · Allow-Origin: https://evil.example.com · Allow-Credentials", "kind": "reply"},
    {"from": "Browser", "to": "user on evil.example.com", "label": "readable: the other site now has the notes", "kind": "reply"}
  ]
}
:::

The fix is an exact lookup in a set of full origins. The near misses are well documented (PortSwigger's
[CORS vulnerabilities](https://portswigger.net/web-security/cors) page lists them) and they all come from
treating an origin as a string to pattern-match:

| Check | Lets through |
|---|---|
| echo whatever arrives | every site |
| \`origin.startswith("https://app.example.com")\` | \`https://app.example.com.evil.net\` |
| \`origin.endswith("example.com")\` | \`https://evilexample.com\` |
| regex \`https://app.example.com\` with an unescaped dot | \`https://appXexample.com\` |
| allowlist contains \`null\` | sandboxed iframes and \`file:\` pages of any site, which send \`Origin: null\` |
| host compared, scheme ignored | \`http://app.example.com\`, which anyone on the network can impersonate |

An origin is scheme, host and port; \`https://app.example.com\` and \`http://app.example.com\` are different
origins, and only one is on the list. A refusal grants nothing, on the preflight and on the actual
response.

:::quiz
Q: The server allows an origin when origin.startswith("https://app.example.com"). Which origin gets a credentialed grant it should not?
- [ ] https://app.example.com:443
- [x] https://app.example.com.evil.net
- [ ] https://admin.example.com
> Anyone can register app.example.com.evil.net, and it begins with the allowed string. Only an exact match against full origins (scheme, host, port) is safe.
:::

# CORS is not CSRF protection

CORS controls who may **read** a response. It does not stop a request from being **sent**, and the
server runs every request it receives. In the drill, a \`POST\` from a disallowed origin still answers 201
and the note exists afterwards; only the grant is missing. That is correct behaviour for a CORS layer,
and it is exactly why CORS cannot defend state-changing endpoints:

- A simple request is never preflighted. A cross-site form posting \`text/plain\` to an endpoint that
  accepts it, with the user's cookies attached, changes state, and the attacker does not need to read
  the response.
- A preflight only stops what the browser chooses to preflight. Non-browser clients ignore CORS
  entirely; \`curl\` sends any \`Origin\` it likes.

What does defend writes, per the [OWASP CSRF cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html):

| Defence | How it works |
|---|---|
| \`SameSite=Lax\` or \`Strict\` cookies | the browser leaves the session cookie off cross-site requests |
| CSRF token | a secret the attacker's page cannot read must accompany each write |
| \`Origin\` check on writes | the server *refuses* (not just ungrants) writes from origins it does not know |
| JSON-only writes | the server rejects writes whose \`Content-Type\` is not \`application/json\`; a form cannot send that, and a JSON request is preflighted |

The drill's CORS layer provides none of these, by design: it grants or withholds reads, and the routes
behind it run for every caller. Which defence a real API adds is a separate decision from its CORS policy.

:::quiz
Q: A page on evil.example.com submits a hidden form (text/plain) to POST /api/notes with the user's cookies. The CORS layer refuses that origin. What stops the note being created?
- [ ] CORS: the browser blocks the request because the origin is not allowed
- [ ] The preflight: the browser asks first and gets a 403
- [x] Nothing in CORS: a simple request is sent without a preflight; SameSite cookies, a CSRF token or a server-side Origin check must stop it
> CORS hides the response from the attacker's script but the request has already been processed. A form post is simple, so no preflight is sent. Writes need their own defence.
:::

# What to take away

- **Answer the preflight yourself, before routing.** \`OPTIONS\` + \`Origin\` + \`Access-Control-Request-Method\`:
  204 with the full grant when origin, method and every requested header are allowed, 403 with no
  \`Access-Control-*\` header otherwise.
- **Echo one origin, found by exact lookup.** Credentials forbid \`*\`; reflecting any origin, prefix and
  suffix matches, scheme-blind comparisons and \`null\` all hand a user's data to another site.
- **Vary on Origin everywhere.** Every \`/api\` response, granted or not, so shared caches keep one
  origin's answer from reaching another.
- **Max-Age is a revocation delay.** 600 s saves a round trip per URL and method, and means a removed
  origin keeps working for up to ten minutes.
- **CORS declares who may read, not who may write.** Disallowed origins still get normal answers;
  protect state changes with \`SameSite\` cookies, CSRF tokens or an \`Origin\` check that refuses.

The primary reference is the [CORS protocol section of the Fetch standard](https://fetch.spec.whatwg.org/#http-cors-protocol);
MDN's [CORS guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) covers the simple
request rules and the \`Max-Age\` caps in browser terms.
`;
