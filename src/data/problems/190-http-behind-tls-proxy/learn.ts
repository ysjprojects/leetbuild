/**
 * The learning guide for the TLS-proxy drill: what TLS termination hides from the service, the
 * forwarded headers that carry it back, why only a trusted peer's headers count and why the
 * X-Forwarded-For walk runs right to left, the 308 redirect, HSTS, and where real stacks put all of it.
 * Rendered at `/http-behind-tls-proxy/learn`.
 */
export const learn = `# The mechanism at a glance

Most services never see TLS. A load balancer accepts the client's HTTPS connection, decrypts it, and opens
a second, plain-HTTP connection to the service. That second hop loses two facts the service needs: the
**scheme** the client used and the client's **address**. The proxy writes them into headers, and the
service has to decide when to believe them.

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Client", "sub": "203.0.113.7 · https://shop.example.com", "x": 12, "y": 50},
    {"id": "lb", "kind": "external", "label": "Load balancer", "sub": "10.0.0.2 · 10.0.0.3 · terminates TLS", "x": 45, "y": 50},
    {"id": "service", "kind": "service", "label": "Service", "sub": "resolve() · 308 for http · HSTS for https", "x": 80, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "lb", "kind": "http", "label": "HTTPS"},
    {"from": "lb", "to": "service", "kind": "http", "label": "HTTP · X-Forwarded-*"}
  ]
}
:::

The contract the drill implements:

- \`TRUSTED_PROXIES = {"10.0.0.2", "10.0.0.3"}\` and \`HSTS = "max-age=63072000; includeSubDomains"\`.
- \`GET /whoami\` answers \`{"client_ip": …, "scheme": "http" | "https"}\`, \`GET /healthz\` answers \`ok\`,
  \`POST /orders\` answers 201 and records the order.
- When the peer is a trusted proxy, the scheme is the first value of \`X-Forwarded-Proto\`, lowercased, and the
  client IP comes from walking \`X-Forwarded-For\` right to left past the trusted hops. From any other peer,
  every \`X-Forwarded-*\` header is ignored.
- Effective http on any path but \`/healthz\` gets a 308 to the same URL on https, with an empty body and no
  side effect. Effective https gets \`Strict-Transport-Security\` on every response, 404s included.

# What TLS termination takes away

Terminating TLS at the edge is the normal shape, not a shortcut: certificates live in one place, the
handshake cost is paid by machines built for it, and the proxy can route by path or host because it reads
the request. The price is that the service sees a different connection from the one the client opened.

| Fact | What the client had | What the service sees without headers |
| --- | --- | --- |
| Scheme | \`https\` | \`http\`: its own listener is plain |
| Client address | \`203.0.113.7\` | \`10.0.0.2\`: the proxy's address |
| Host | \`shop.example.com\` | usually passed through as \`Host\` |
| Port | 443 | 8080 |

Both losses cause real bugs:

- **Wrong scheme.** A service that thinks every request is http builds \`http://\` links and redirect
  targets, sets cookies without \`Secure\`, and, if it redirects http to https, redirects *every* request,
  including the ones that were already https. The client follows the redirect back through the proxy, gets
  the same answer, and loops.
- **Wrong address.** Rate limits, audit logs, fraud scores and geo rules all key on the client address.
  Behind a proxy every client is \`10.0.0.2\`: one noisy client throttles everybody, and the audit log says
  the load balancer placed every order.

So the proxy reports what it saw. The de facto headers are \`X-Forwarded-Proto\` (the scheme) and
\`X-Forwarded-For\` (the address chain). [RFC 7239](https://www.rfc-editor.org/rfc/rfc7239) standardised the
same information as one header, \`Forwarded: for=203.0.113.7;proto=https\`, with the same trust problem.

:::quiz
Q: A service behind a TLS-terminating proxy redirects every http request to https but reads the scheme from its own listener. What happens?
- [ ] Nothing visible: the proxy rewrites the redirect
- [x] Every request is redirected, including the https ones, and browsers loop until they give up
- [ ] Only the first request is redirected; the browser caches the answer
> The service's own listener is always plain http, so every request looks like http to it. The client follows the redirect to https, the proxy forwards it over http again, and the service redirects again. The scheme has to come from the proxy's header.
:::

# Trust the peer, not the header

A forwarded header is a claim made by whoever opened the TCP connection to the service. Nothing in HTTP
stops a client from sending \`X-Forwarded-Proto: https\` or \`X-Forwarded-For: 10.0.0.2\` itself. The only fact
the service has that the client cannot forge is the connection's remote address, the **peer**. So the
decision is made on the peer first, and the headers are read only if it passes.

:::sequence
{
  "participants": ["attacker 198.51.100.23", "service"],
  "messages": [
    {"from": "attacker 198.51.100.23", "to": "service", "label": "POST /orders · X-Forwarded-Proto: https · X-Forwarded-For: 10.0.0.2", "kind": "sync"},
    {"from": "service", "to": "service", "label": "naive: trusts the headers → https, client 10.0.0.2", "kind": "sync"},
    {"from": "service", "to": "attacker 198.51.100.23", "label": "201 · order recorded from an internal address", "kind": "reply"},
    {"from": "attacker 198.51.100.23", "to": "service", "label": "same request, to the proxy-aware service", "kind": "sync"},
    {"from": "service", "to": "service", "label": "peer 198.51.100.23 not trusted · headers ignored → http", "kind": "sync"},
    {"from": "service", "to": "attacker 198.51.100.23", "label": "308 · Location: https://shop.example.com/orders · nothing recorded", "kind": "reply"}
  ]
}
:::

- The trust list is **exact addresses** (or exact CIDR ranges in real deployments). \`10.0.0.20\` is not
  \`10.0.0.2\`; a prefix match is a hole.
- The peer must come from the socket. Some framework helpers return "the client IP" after reading the
  headers themselves (Pekko HTTP's \`extractClientIP\` does); using one of those for the trust decision
  trusts the attacker's claim about being trusted.
- If the service is reachable *only* through the proxy (a private subnet, a firewall rule), the trust list
  is a second line of defence, not the only one. It still matters: networks change, and a debug port or a
  sidecar opens a path that skips the proxy.

:::quiz
Q: Why is the trust decision made on the peer address and not on the last X-Forwarded-For hop?
- [ ] The last hop is always the client
- [x] The peer comes from the socket and cannot be forged; every header, including the last hop, can be written by the client
- [ ] The headers are stripped by the proxy anyway
> A direct client can send any X-Forwarded-For it likes, including one that ends in 10.0.0.2. Only the TCP connection's remote address is set by the network rather than by the sender.
:::

# Walking X-Forwarded-For from the right

Each proxy **appends** the address it received the connection from; none rewrites what was already there.
So a chain through two load balancers looks like this when it reaches the service:

\`\`\`text
X-Forwarded-For: 1.2.3.4, 203.0.113.7, 10.0.0.3
peer:            10.0.0.2

1.2.3.4       written by the client itself
203.0.113.7   appended by LB 10.0.0.3: the address it saw
10.0.0.3      appended by LB 10.0.0.2: the address it saw
\`\`\`

The client sent its own \`X-Forwarded-For: 1.2.3.4\`. The outer balancer \`10.0.0.3\` appended the address it
saw, \`203.0.113.7\`; the inner one appended \`10.0.0.3\`. Only the entries your own proxies appended are
facts, and they form a **suffix** of the list. The client is the first hop from the right that is not one
of yours:

| X-Forwarded-For (peer trusted) | Right-to-left walk | Client |
| --- | --- | --- |
| \`1.2.3.4, 203.0.113.7, 10.0.0.3\` | 10.0.0.3 trusted, 203.0.113.7 not | \`203.0.113.7\` |
| \`203.0.113.7,10.0.0.3,10.0.0.2\` | two trusted, then 203.0.113.7 | \`203.0.113.7\` |
| \`10.0.0.3, 10.0.0.2\` | all trusted | \`10.0.0.3\` (leftmost) |
| absent | nothing to walk | the peer |

The leftmost entry is the one the client controls. Taking it is the classic mistake, and it is what
Fastify does with \`trustProxy: true\`: \`request.ip\` becomes the first hop. With an explicit list,
\`trustProxy: ['10.0.0.2', '10.0.0.3']\`, Fastify walks from the right like this drill does. MDN's
[X-Forwarded-For page](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For)
spells out the same rule: pick the rightmost untrusted address.

:::details Several X-Forwarded-For lines
HTTP lets a list header arrive as several lines, and they mean the same as one line joined with commas,
in order. A proxy that adds its own line instead of appending to the existing one is legal. Join every
line before walking: reading only the first line would hand the client's own line back as the answer.
:::

:::quiz
Q: Through peer 10.0.0.2, X-Forwarded-For is "1.2.3.4, 203.0.113.7, 10.0.0.3". Which address is the client?
- [ ] 1.2.3.4, the first entry
- [x] 203.0.113.7, the first untrusted hop from the right
- [ ] 10.0.0.3, the last entry
> 10.0.0.3 is our own balancer, so skip it. 203.0.113.7 is the address our outer balancer saw the connection come from: a fact. 1.2.3.4 is whatever the client chose to write.
:::

# The redirect: 308, empty, before anything runs

A request that arrived over plain http is answered without touching the application:

\`\`\`http
HTTP/1.1 308 Permanent Redirect
Location: https://shop.example.com/orders?ref=mail
Content-Length: 0
\`\`\`

- **308, not 301.** Historically, browsers turned a redirected \`POST\` into a \`GET\` on 301 and 302;
  [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#name-308-permanent-redirect) keeps that allowance for
  them. 307 and 308 forbid it: the client repeats the same method and body. 308 is the permanent one, so
  caches and clients may remember it.
- **Exact target.** \`https://\`, the \`Host\` header, the path, and the query only when there is one. Losing
  the query loses the user's search or tracking parameters; a trailing \`?\` makes a different cache key.
- **No side effect.** The redirect sits in the middleware, before routing. A plain-http \`POST /orders\`
  must not create an order and then redirect, or the client's replay over https creates a second one.
- **Empty body.** Helpers such as Go's \`http.Redirect\` and Pekko's \`redirect\` write a small HTML page;
  setting the status and \`Location\` by hand keeps the body empty.
- **\`/healthz\` is exempt.** The load balancer probes it over the internal plain-http hop. Redirecting the
  probe makes every instance look unhealthy.

:::quiz
Q: Why does the redirect run before the route handler instead of after it?
- [ ] Handlers are slower than middleware
- [x] A handler that ran would already have done its work: a plain-http POST would record an order, and the https replay would record another
- [ ] The Location header can only be set in middleware
> The redirect means "this request was not accepted; send it again over https". Anything the handler does first is a side effect of a request the service refused.
:::

# HSTS: on every https response, never over http

\`Strict-Transport-Security\` tells the browser to use https for this host for \`max-age\` seconds, without
asking. After the first visit, a user who types \`shop.example.com\` never sends a plain-http request at all,
so there is no first request for an attacker on the network to intercept. \`includeSubDomains\` extends that
to every subdomain.

| Response | HSTS? | Why |
| --- | --- | --- |
| https \`/whoami\` 200 | yes | the policy applies to the host, not the route |
| https \`/no-such-route\` 404 | yes | a 404 is still an https response from this host |
| http 308 | no | [RFC 6797](https://www.rfc-editor.org/rfc/rfc6797#section-7.2) §7.2: never over plain http |
| http \`/healthz\` 200 | no | same rule; the probe is not a browser anyway |

- Over plain http, a browser **ignores** the header, because anyone on the path could have injected it, and
  could equally inject a \`max-age=0\` to switch HSTS off. Sending it there is wrong and useless.
- The header goes on after routing, so a 404 or an error response carries it: in FastAPI after
  \`call_next\`, in Fastify an \`onSend\` hook, in Go before \`next.ServeHTTP\`, in Pekko HTTP around a sealed
  route, in cpp-httplib a post-routing handler.
- **Preload.** The first visit is still unprotected. Adding \`preload\` and submitting the domain to the
  browsers' preload list ships the policy inside the browser. It is hard to undo: every subdomain must
  serve https for as long as the list holds the entry, which is why the drill's policy stops at
  \`includeSubDomains\`.

:::quiz
Q: The service adds HSTS in each route handler. Which response goes out without it?
- [ ] The https 308
- [x] An https 404 for a path no handler matches
- [ ] The https /whoami
> A 404 for an unknown path is produced by the framework, not by any handler, so a per-route header never reaches it. Setting it once after routing covers every response.
:::

# Where this lives in real stacks

Nobody writes this by hand twice. Every server has a switch, and every switch has the same two settings:
whose headers to trust, and which end of the list to read.

| Stack | Setting | Default trap |
| --- | --- | --- |
| uvicorn | \`--proxy-headers --forwarded-allow-ips 10.0.0.2,10.0.0.3\` | \`'*'\` trusts everyone |
| Fastify | \`trustProxy: ['10.0.0.2', '10.0.0.3']\` | \`true\` returns the leftmost hop |
| Go | middleware over \`r.RemoteAddr\` and \`X-Forwarded-For\` | \`r.RemoteAddr\` alone is the proxy |
| nginx | \`set_real_ip_from\` + \`real_ip_recursive on\` | without recursive, only the last hop |

- Go's standard library parses neither header; popular middleware such as chi's \`RealIP\` takes the header
  without checking the peer, so it is safe only when nothing but the proxy can reach the service.
- The redirect and HSTS often move to the load balancer itself, which sees the real scheme. The service
  still needs the scheme for absolute links and \`Secure\` cookies, and the client address for everything
  keyed on it.

:::quiz
Q: A Fastify service sets trustProxy: true behind one load balancer. What does request.ip report for X-Forwarded-For "1.2.3.4, 203.0.113.7"?
- [x] 1.2.3.4, the address the client wrote into its own header
- [ ] 203.0.113.7, the address the balancer saw
- [ ] The balancer's own address
> trustProxy: true trusts every hop and returns the leftmost one. Listing the proxies, trustProxy: ['10.0.0.2', '10.0.0.3'], makes Fastify walk from the right and stop at the first untrusted address.
:::

# What to take away

- **TLS termination hides two facts**: the scheme and the client address. The proxy reports them in
  \`X-Forwarded-Proto\` and \`X-Forwarded-For\` (or RFC 7239 \`Forwarded\`).
- **Trust is decided by the peer.** The socket's remote address is the one thing a client cannot forge;
  headers from any peer outside \`TRUSTED_PROXIES\` are ignored entirely.
- **Walk \`X-Forwarded-For\` from the right.** Your proxies' entries are a suffix; the first hop that is not
  yours is the client, and the leftmost is whatever the client wrote.
- **Redirect with 308, empty, before the handler**, to \`https://<Host><path>[?query]\`, and keep the health
  probe on plain http.
- **HSTS on every https response and never over http**, added after routing so 404s carry it.

The primary reference is [RFC 7239](https://www.rfc-editor.org/rfc/rfc7239), *Forwarded HTTP Extension*,
with [RFC 6797](https://www.rfc-editor.org/rfc/rfc6797) for HSTS.
`;
