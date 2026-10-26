import type {Step} from '@/lib/types';

export const forwardedHeadersStep: Step = {
  id: 'forwarded-headers',
  title: 'Scheme and client IP from a trusted proxy, 308 for plain http',
  concept: 'http',
  file: 'proxy_aware',
  focus: ['client', 'lb', 'service'],
  task: `## Task

The service sits behind a load balancer that terminates TLS and talks plain HTTP to it from \`10.0.0.2\` or
\`10.0.0.3\`. Make the service see the scheme and the address the **client** used, and keep plain HTTP out.

- **Constants**: \`TRUSTED_PROXIES = {"10.0.0.2", "10.0.0.3"}\`, \`HSTS = "max-age=63072000; includeSubDomains"\`.
- **Routes**: \`GET /whoami\` → 200 \`{"client_ip": …, "scheme": "http" | "https"}\`; \`GET /healthz\` → 200 \`ok\`
  (text); \`POST /orders\` → 201 and appends the JSON body to the module-level list \`ORDERS\`.
- **The peer** is the connection's remote address: Python \`request.client.host\`, TypeScript \`request.ip\` with
  Fastify's \`trustProxy\` left off.
- **Trusted peer, scheme** (peer in \`TRUSTED_PROXIES\`): the first value of \`X-Forwarded-Proto\`, lowercased
  (\`HTTPS, http\` → \`https\`); the request's own scheme when the header is absent.
- **Trusted peer, client IP**: walk \`X-Forwarded-For\` **right to left**, skipping \`TRUSTED_PROXIES\`; the first
  other address is the client. Every hop trusted → the leftmost. No header → the peer.
- **Untrusted peer**: ignore every \`X-Forwarded-*\` header. Scheme = the request's own, client IP = the peer.
- **Effective http**, any path but \`/healthz\`: **308** with \`Location: https://<Host><path>[?query]\` and an empty
  body. The handler never runs, so a redirected \`POST /orders\` records nothing.
- **Effective https**: every response, 404s included, carries \`Strict-Transport-Security: <HSTS>\`. Plain-http
  responses never do (RFC 6797 §7.2).

> \`X-Forwarded-For\` is a list anyone can start. Only the hops your own proxies appended are facts, and they
> are on the right; the leftmost entry is whatever the client chose to write.`,
  sequence: {
    participants: ['Client 203.0.113.7', 'LB 10.0.0.2', 'service'],
    messages: [
      {
        from: 'Client 203.0.113.7',
        to: 'LB 10.0.0.2',
        label: 'TLS · GET /whoami · X-Forwarded-For: 1.2.3.4 (forged)',
        kind: 'sync',
      },
      {
        from: 'LB 10.0.0.2',
        to: 'service',
        label: 'GET /whoami · X-Forwarded-Proto: https · X-Forwarded-For: 1.2.3.4, 203.0.113.7',
        kind: 'sync',
      },
      {from: 'service', to: 'service', label: 'peer 10.0.0.2 trusted · walk right to left → 203.0.113.7', kind: 'sync'},
      {
        from: 'service',
        to: 'LB 10.0.0.2',
        label: '200 {"client_ip": "203.0.113.7", "scheme": "https"} · Strict-Transport-Security',
        kind: 'reply',
      },
      {from: 'LB 10.0.0.2', to: 'service', label: 'POST /orders?ref=mail · X-Forwarded-Proto: http', kind: 'sync'},
      {
        from: 'service',
        to: 'LB 10.0.0.2',
        label: '308 · Location: https://shop.example.com/orders?ref=mail · no order recorded',
        kind: 'reply',
      },
    ],
  },
  hints: [
    "Write one function that answers `(client_ip, scheme)` for a request and call it from both the middleware (or hook) and `/whoami`. Its first line decides everything: is the peer in `TRUSTED_PROXIES`? If not, return the peer and the request's own scheme and never look at a header.",
    'For a trusted peer: `proto.split(",")[0].strip().lower()` gives the scheme. For the client, split `X-Forwarded-For` on commas, strip each hop, iterate from the end and return the first hop not in `TRUSTED_PROXIES`; fall back to the first hop, then to the peer. Fastify\'s `trustProxy: true` returns the leftmost hop, which is the forgeable one.',
    'The redirect and HSTS both live in the middleware: the redirect returns before `call_next` (a hook that sends a reply), the HSTS header goes on after it (an `onSend` hook in Fastify, which also runs on 404s). Build `Location` from the `Host` header, the path and the raw query, and send it with no body.',
  ],
  checks: [
    {
      id: 'https-via-proxy',
      title: "A trusted proxy's X-Forwarded-Proto makes the request https",
      detail:
        'From peer `10.0.0.2` with `X-Forwarded-Proto: https` and `X-Forwarded-For: 203.0.113.7`, `GET /whoami` answers 200 `{"client_ip": "203.0.113.7", "scheme": "https"}`; `HTTPS, http` counts as `https`; with no `X-Forwarded-For` the client is the peer; `POST /orders` answers 201 and is recorded.',
      match: {
        python: {all: [/x-forwarded-proto/i, /split\(\s*["'],["']\s*\)\s*\[0\]/, /\.lower\(\)/]},
        typescript: {all: [/x-forwarded-proto/i, /split\(\s*['"],['"]\s*\)\s*\[0\]/, /\.toLowerCase\(\)/]},
        go: {all: [/X-Forwarded-Proto/, /strings\.Split\(\s*\w+\s*,\s*","\s*\)\s*\[0\]/, /strings\.ToLower\(/]},
        scala: {all: [/x-forwarded-proto/i, /split\(\s*","\s*\)\.head/, /toLowerCase/]},
        cpp: {all: [/"X-Forwarded-Proto"/, /substr\(\s*0\s*,\s*\w+\.find\(\s*','\s*\)\s*\)/, /tolower/]},
      },
    },
    {
      id: 'redirect-308',
      title: 'Plain http gets a 308 to the exact https URL, and nothing runs',
      detail:
        '`GET /whoami?verbose=1&ref=mail` over http answers 308 with `Location: https://shop.example.com/whoami?verbose=1&ref=mail` and an empty body; without a query there is no `?`. A `POST /orders?ref=mail` the proxy forwarded as `http` gets the same 308 and `ORDERS` stays empty.',
      match: {
        python: {
          all: [/status_code\s*=\s*(308|status\.HTTP_308_PERMANENT_REDIRECT)/, /f["']https:\/\/\{/, /\.url\.query/],
          none: [/status_code\s*=\s*30[1237]\b/],
        },
        typescript: {
          all: [/redirect\([^\n]*\b308\b|code\(\s*308\s*\)/, /`https:\/\/\$\{/, /request\.url\b/],
          none: [/redirect\([^\n]*\b30[1237]\b/],
        },
        go: {
          all: [
            /http\.StatusPermanentRedirect|WriteHeader\(\s*308\s*\)/,
            /"https:\/\/"\s*\+\s*r\.Host/,
            /r\.URL\.RawQuery/,
          ],
          none: [/http\.Status(MovedPermanently|Found|SeeOther|TemporaryRedirect)/],
        },
        scala: {
          all: [/StatusCodes\.PermanentRedirect/, /s"https:\/\/\$/, /rawQueryString/],
          none: [/StatusCodes\.(MovedPermanently|Found|SeeOther|TemporaryRedirect)/],
        },
        cpp: {
          all: [/res\.status\s*=\s*308/, /"https:\/\/"\s*\+\s*req\.get_header_value\(\s*"Host"\s*\)/, /req\.target/],
          none: [/res\.status\s*=\s*30[1237]\b/],
        },
      },
    },
    {
      id: 'untrusted-spoof',
      title: 'Forwarded headers from an untrusted peer are ignored',
      detail:
        'Peer `198.51.100.23` sending `X-Forwarded-Proto: https` and `X-Forwarded-For: 10.0.0.2` is still plain http: 308, no HSTS, and its `POST /orders` records nothing. Peer `10.0.0.20` is not `10.0.0.2`.',
      match: {
        python: {
          all: [/request\.client\.host/, /\b\w*(peer|client|host)\w*\s+(not\s+)?in\s+TRUSTED_PROXIES/],
          none: [/ProxyHeadersMiddleware|proxy_headers\s*=\s*True|forwarded_allow_ips/],
        },
        typescript: {
          all: [/TRUSTED_PROXIES\.has\(\s*(peer|request\.ip)\s*\)/],
          none: [/trustProxy/],
        },
        go: {all: [/net\.SplitHostPort\(\s*r\.RemoteAddr/, /trustedProxies\[\s*peer\s*\]/]},
        scala: {
          all: [/AttributeKeys\.remoteAddress/, /TrustedProxies\.contains\(\s*peer\s*\)/],
          none: [/extractClientIP/],
        },
        cpp: {all: [/req\.remote_addr/, /kTrustedProxies\.count\(\s*peer\s*\)/]},
      },
    },
    {
      id: 'xff-walk',
      title: 'X-Forwarded-For is walked right to left past the trusted hops',
      detail:
        "Through `10.0.0.2`, `X-Forwarded-For: 1.2.3.4, 203.0.113.7, 10.0.0.3` gives `203.0.113.7` (the leftmost, `1.2.3.4`, is what the client wrote and what Fastify's `trustProxy: true` would report); `10.0.0.3, 10.0.0.2` gives `10.0.0.3`; hops without spaces parse the same.",
      match: {
        python: {
          all: [/x-forwarded-for/i, /reversed\(|\[::-1\]/, /not\s+in\s+TRUSTED_PROXIES/],
          none: [/ProxyHeadersMiddleware|proxy_headers\s*=\s*True/],
        },
        typescript: {
          all: [
            /x-forwarded-for/i,
            /length\s*-\s*1;\s*\w+\s*>=\s*0|\.reverse\(\)|\.findLast\(/,
            /!TRUSTED_PROXIES\.has\(/,
          ],
          none: [/trustProxy/],
        },
        go: {
          all: [/X-Forwarded-For/, /len\(\w+\)\s*-\s*1;\s*\w+\s*>=\s*0;\s*\w+--/, /!trustedProxies\[/],
        },
        scala: {
          all: [/x-forwarded-for/i, /reverseIterator|\.reverse\b|findLast/, /!TrustedProxies\.contains\(/],
          none: [/extractClientIP/],
        },
        cpp: {all: [/"X-Forwarded-For"/, /\.rbegin\(\)/, /!kTrustedProxies\.count\(/]},
      },
    },
    {
      id: 'hsts',
      title: 'HSTS on every https response, 404s included, never over http',
      detail:
        'An https `GET /no-such-route` answers 404 with `Strict-Transport-Security: max-age=63072000; includeSubDomains`, as does `/whoami`; the 308 and an http `/healthz` carry no such header (RFC 6797 §7.2).',
      match: {
        python: {
          all: [
            /HSTS\s*=\s*["']max-age=63072000; includeSubDomains["']/,
            /headers\[\s*["']Strict-Transport-Security["']\s*\]\s*=\s*HSTS/,
            /==\s*["']https["']/,
          ],
        },
        typescript: {
          all: [
            /HSTS\s*=\s*['"]max-age=63072000; includeSubDomains['"]/,
            /addHook\(\s*['"]onSend['"]/,
            /header\(\s*['"]Strict-Transport-Security['"]\s*,\s*HSTS\s*\)/,
          ],
        },
        go: {
          all: [
            /hsts\s*=\s*"max-age=63072000; includeSubDomains"/,
            /Header\(\)\.Set\(\s*"Strict-Transport-Security"\s*,\s*hsts\s*\)/,
            /\.Scheme\s*==\s*"https"/,
          ],
        },
        scala: {
          all: [
            /Hsts\s*=\s*"max-age=63072000; includeSubDomains"/,
            /respondWithHeader\(\s*RawHeader\(\s*"Strict-Transport-Security"\s*,\s*Hsts\s*\)\s*\)/,
            /Route\.seal\(/,
          ],
        },
        cpp: {
          all: [
            /kHsts\s*=\s*"max-age=63072000; includeSubDomains"/,
            /set_post_routing_handler\(/,
            /set_header\(\s*"Strict-Transport-Security"\s*,\s*kHsts\s*\)/,
          ],
        },
      },
    },
    {
      id: 'healthz-exempt',
      title: '/healthz answers over plain http',
      detail:
        'The load balancer probes `GET /healthz` over plain http from inside the network: it answers 200 `ok` with no `Location`, from an untrusted peer and through a proxy that says `http`.',
      match: {
        python: {all: [/\.path\s*!=\s*["']\/healthz["']/]},
        typescript: {all: [/!==\s*['"]\/healthz['"]/]},
        go: {all: [/r\.URL\.Path\s*!=\s*"\/healthz"/]},
        scala: {all: [/!=\s*"\/healthz"/]},
        cpp: {all: [/req\.path\s*!=\s*"\/healthz"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

app = FastAPI()

TRUSTED_PROXIES = {"10.0.0.2", "10.0.0.3"}
HSTS = "max-age=63072000; includeSubDomains"

ORDERS: list[dict] = []


def resolve(request: Request) -> tuple[str, str]:
    """(client_ip, scheme) as the client saw them."""
    # TODO: only when the peer is in TRUSTED_PROXIES: the scheme from X-Forwarded-Proto (first value,
    # lowercased) and the client from X-Forwarded-For (right to left, skipping TRUSTED_PROXIES)
    return request.client.host, request.url.scheme


# TODO: an http middleware: effective http on any path but /healthz → 308 with
# Location: https://<Host><path>[?query] and no body; effective https → Strict-Transport-Security: HSTS


@app.get("/whoami")
async def whoami(request: Request) -> dict[str, str]:
    client_ip, scheme = resolve(request)
    return {"client_ip": client_ip, "scheme": scheme}


@app.get("/healthz", response_class=PlainTextResponse)
async def healthz() -> str:
    return "ok"


@app.post("/orders", status_code=201)
async def create_order(order: dict) -> dict:
    ORDERS.append(order)
    return {"id": len(ORDERS)}
`,
      solution: `from fastapi import FastAPI, Request, Response
from fastapi.responses import PlainTextResponse

app = FastAPI()

TRUSTED_PROXIES = {"10.0.0.2", "10.0.0.3"}
HSTS = "max-age=63072000; includeSubDomains"

ORDERS: list[dict] = []


def client_ip(peer: str, xff: str) -> str:
    """Right to left through X-Forwarded-For: the first hop that is not one of ours is the client."""
    hops = [hop.strip() for hop in xff.split(",") if hop.strip()]
    for hop in reversed(hops):
        if hop not in TRUSTED_PROXIES:
            return hop
    return hops[0] if hops else peer


def resolve(request: Request) -> tuple[str, str]:
    """(client_ip, scheme) as the client saw them. Headers count only when our own proxy sent them."""
    peer = request.client.host if request.client else ""
    if peer not in TRUSTED_PROXIES:
        return peer, request.url.scheme
    proto = request.headers.get("x-forwarded-proto")
    scheme = proto.split(",")[0].strip().lower() if proto else request.url.scheme
    # several X-Forwarded-For lines are one list, in order
    xff = ",".join(request.headers.getlist("x-forwarded-for"))
    return client_ip(peer, xff), scheme


@app.middleware("http")
async def proxy_aware(request: Request, call_next):
    _, scheme = resolve(request)
    if scheme != "https" and request.url.path != "/healthz":
        location = f"https://{request.headers['host']}{request.url.path}"
        if request.url.query:
            location += f"?{request.url.query}"
        # 308, not 301: a client must repeat the same method and body against the https URL
        return Response(status_code=308, headers={"Location": location})
    response = await call_next(request)
    if scheme == "https":
        response.headers["Strict-Transport-Security"] = HSTS
    return response


@app.get("/whoami")
async def whoami(request: Request) -> dict[str, str]:
    client_ip, scheme = resolve(request)
    return {"client_ip": client_ip, "scheme": scheme}


@app.get("/healthz", response_class=PlainTextResponse)
async def healthz() -> str:
    return "ok"


@app.post("/orders", status_code=201)
async def create_order(order: dict) -> dict:
    ORDERS.append(order)
    return {"id": len(ORDERS)}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

export const TRUSTED_PROXIES = new Set(['10.0.0.2', '10.0.0.3']);
export const HSTS = 'max-age=63072000; includeSubDomains';

/** Orders the service accepted, in arrival order. */
export const ORDERS: unknown[] = [];

export const app = Fastify();

type Req = {ip: string; protocol: string; url: string; headers: Record<string, string | string[] | undefined>};

/** The client's address and scheme as the client saw them. */
export function resolve(request: Req): {clientIp: string; scheme: string} {
  // TODO: only when the peer (request.ip) is in TRUSTED_PROXIES: the scheme from X-Forwarded-Proto
  // (first value, lowercased) and the client from X-Forwarded-For (right to left, skipping TRUSTED_PROXIES)
  return {clientIp: request.ip, scheme: request.protocol};
}

// TODO: an onRequest hook: effective http on any path but /healthz → 308 with
// Location: https://<Host><path>[?query] and no body
// TODO: an onSend hook: effective https → Strict-Transport-Security: HSTS

app.get('/whoami', async request => {
  const {clientIp, scheme} = resolve(request);
  return {client_ip: clientIp, scheme};
});

app.get('/healthz', async () => 'ok');

app.post('/orders', async (request, reply) => {
  ORDERS.push(request.body);
  return reply.code(201).send({id: ORDERS.length});
});
`,
      solution: `import Fastify from 'fastify';

export const TRUSTED_PROXIES = new Set(['10.0.0.2', '10.0.0.3']);
export const HSTS = 'max-age=63072000; includeSubDomains';

/** Orders the service accepted, in arrival order. */
export const ORDERS: unknown[] = [];

// No proxy option: request.ip stays the peer, and resolve() decides what the headers are worth.
export const app = Fastify();

type Req = {ip: string; protocol: string; url: string; headers: Record<string, string | string[] | undefined>};

/** One header as a single string: several lines of a list header are one list, in order. */
function headerValue(request: Req, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

/** Right to left through X-Forwarded-For: the first hop that is not one of ours is the client. */
export function clientIp(peer: string, xff: string | undefined): string {
  const hops = (xff ?? '')
    .split(',')
    .map(hop => hop.trim())
    .filter(hop => hop !== '');
  for (let i = hops.length - 1; i >= 0; i -= 1) if (!TRUSTED_PROXIES.has(hops[i])) return hops[i];
  return hops[0] ?? peer;
}

/** The client's address and scheme as the client saw them. Headers count only when our own proxy sent them. */
export function resolve(request: Req): {clientIp: string; scheme: string} {
  const peer = request.ip;
  if (!TRUSTED_PROXIES.has(peer)) return {clientIp: peer, scheme: request.protocol};
  const proto = headerValue(request, 'x-forwarded-proto');
  return {
    clientIp: clientIp(peer, headerValue(request, 'x-forwarded-for')),
    scheme: proto ? proto.split(',')[0].trim().toLowerCase() : request.protocol,
  };
}

app.addHook('onRequest', async (request, reply) => {
  const path = request.url.split('?')[0];
  if (resolve(request).scheme !== 'https' && path !== '/healthz') {
    // request.url keeps the raw query; 308 makes the client repeat the same method and body
    return reply.redirect(\`https://\${request.headers.host}\${request.url}\`, 308);
  }
});

// onSend runs for every reply, the 404s included
app.addHook('onSend', async (request, reply) => {
  if (resolve(request).scheme === 'https') reply.header('Strict-Transport-Security', HSTS);
});

app.get('/whoami', async request => {
  const {clientIp, scheme} = resolve(request);
  return {client_ip: clientIp, scheme};
});

app.get('/healthz', async () => 'ok');

app.post('/orders', async (request, reply) => {
  ORDERS.push(request.body);
  return reply.code(201).send({id: ORDERS.length});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
)

var trustedProxies = map[string]bool{"10.0.0.2": true, "10.0.0.3": true}

const hsts = "max-age=63072000; includeSubDomains"

var (
	mu     sync.Mutex
	orders []map[string]any
)

type origin struct{ ClientIP, Scheme string }

// resolve answers the client's address and scheme as the client saw them.
func resolve(r *http.Request) origin {
	// TODO: only when the peer is in trustedProxies: the scheme from X-Forwarded-Proto (first value,
	// lowercased) and the client from X-Forwarded-For (right to left, skipping trustedProxies)
	_ = strings.Split
	_ = net.SplitHostPort
	return origin{ClientIP: r.RemoteAddr, Scheme: "http"}
}

// proxyAware wraps every route.
func proxyAware(next http.Handler) http.Handler {
	// TODO: effective http on any path but /healthz → 308, Location: https://<Host><path>[?query], no body
	// TODO: effective https → Strict-Transport-Security: hsts
	return next
}

func whoami(w http.ResponseWriter, r *http.Request) {
	o := resolve(r)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"client_ip": o.ClientIP, "scheme": o.Scheme})
}

func healthz(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
}

func createOrder(w http.ResponseWriter, r *http.Request) {
	var order map[string]any
	if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	mu.Lock()
	orders = append(orders, order)
	id := len(orders)
	mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]int{"id": id})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /whoami", whoami)
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("POST /orders", createOrder)
	log.Fatal(http.ListenAndServe(":8080", proxyAware(mux)))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
)

var trustedProxies = map[string]bool{"10.0.0.2": true, "10.0.0.3": true}

const hsts = "max-age=63072000; includeSubDomains"

var (
	mu     sync.Mutex
	orders []map[string]any
)

type origin struct{ ClientIP, Scheme string }

// clientIP walks X-Forwarded-For right to left: the first hop that is not one of ours is the client.
func clientIP(peer, xff string) string {
	var hops []string
	for _, hop := range strings.Split(xff, ",") {
		if hop = strings.TrimSpace(hop); hop != "" {
			hops = append(hops, hop)
		}
	}
	for i := len(hops) - 1; i >= 0; i-- {
		if !trustedProxies[hops[i]] {
			return hops[i]
		}
	}
	if len(hops) > 0 {
		return hops[0]
	}
	return peer
}

// resolve answers the client's address and scheme. Headers count only when our own proxy sent them.
func resolve(r *http.Request) origin {
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peer = r.RemoteAddr
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if !trustedProxies[peer] {
		return origin{ClientIP: peer, Scheme: scheme}
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		scheme = strings.ToLower(strings.TrimSpace(strings.Split(proto, ",")[0]))
	}
	// several X-Forwarded-For lines are one list, in order
	xff := strings.Join(r.Header.Values("X-Forwarded-For"), ",")
	return origin{ClientIP: clientIP(peer, xff), Scheme: scheme}
}

// proxyAware wraps every route: plain http is redirected before any handler runs, https gets HSTS.
func proxyAware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		o := resolve(r)
		if o.Scheme != "https" && r.URL.Path != "/healthz" {
			target := "https://" + r.Host + r.URL.Path
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			// not http.Redirect: it writes an HTML body for GET
			w.Header().Set("Location", target)
			w.WriteHeader(http.StatusPermanentRedirect)
			return
		}
		if o.Scheme == "https" {
			w.Header().Set("Strict-Transport-Security", hsts)
		}
		next.ServeHTTP(w, r)
	})
}

func whoami(w http.ResponseWriter, r *http.Request) {
	o := resolve(r)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"client_ip": o.ClientIP, "scheme": o.Scheme})
}

func healthz(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
}

func createOrder(w http.ResponseWriter, r *http.Request) {
	var order map[string]any
	if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	mu.Lock()
	orders = append(orders, order)
	id := len(orders)
	mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]int{"id": id})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /whoami", whoami)
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("POST /orders", createOrder)
	// plain HTTP: TLS ends at the load balancer
	log.Fatal(http.ListenAndServe(":8080", proxyAware(mux)))
}
`,
    },
    scala: {
      starter: `import scala.collection.mutable.ListBuffer

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.{Location, RawHeader}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ProxyAware {
  val TrustedProxies: Set[String] = Set("10.0.0.2", "10.0.0.3")
  val Hsts = "max-age=63072000; includeSubDomains"
  val orders: ListBuffer[String] = ListBuffer.empty

  final case class Origin(clientIp: String, scheme: String)

  /** The client's address and scheme as the client saw them. */
  def resolve(request: HttpRequest): Origin = {
    val peer = request.attribute(AttributeKeys.remoteAddress).flatMap(_.toOption).map(_.getHostAddress).getOrElse("")
    // TODO: only when the peer is in TrustedProxies: the scheme from X-Forwarded-Proto (first value,
    // lowercased) and the client from X-Forwarded-For (right to left, skipping TrustedProxies)
    Origin(peer, request.uri.scheme)
  }

  val api: Route = concat(
    path("whoami") {
      get {
        extractRequest { request =>
          val o = resolve(request)
          complete(HttpEntity(ContentTypes.\`application/json\`, s"""{"client_ip":"\${o.clientIp}","scheme":"\${o.scheme}"}"""))
        }
      }
    },
    path("healthz") {
      get {
        complete("ok")
      }
    },
    path("orders") {
      post {
        entity(as[String]) { body =>
          val id = orders.synchronized { orders += body; orders.size }
          complete(StatusCodes.Created, HttpEntity(ContentTypes.\`application/json\`, s"""{"id":$id}"""))
        }
      }
    },
  )

  // TODO: effective http on any path but /healthz → 308, Location: https://<Host><path>[?query], no body
  // TODO: effective https → Strict-Transport-Security: Hsts on every response, 404s included
  val route: Route = api

  def main(args: Array[String]): Unit = {
    // pekko.http.server.remote-address-attribute = on
    implicit val system: ActorSystem = ActorSystem("proxy-aware")
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
      solution: `import scala.collection.mutable.ListBuffer

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.{Location, RawHeader}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ProxyAware {
  val TrustedProxies: Set[String] = Set("10.0.0.2", "10.0.0.3")
  val Hsts = "max-age=63072000; includeSubDomains"
  val orders: ListBuffer[String] = ListBuffer.empty

  final case class Origin(clientIp: String, scheme: String)

  /** Right to left through X-Forwarded-For: the first hop that is not one of ours is the client. */
  def clientIp(peer: String, xff: Seq[String]): String = {
    val hops = xff.flatMap(_.split(",")).map(_.trim).filter(_.nonEmpty)
    hops.reverseIterator.find(hop => !TrustedProxies.contains(hop)).orElse(hops.headOption).getOrElse(peer)
  }

  /** The client's address and scheme. The peer is the socket, never a header; headers count only from our proxy. */
  def resolve(request: HttpRequest): Origin = {
    val peer = request.attribute(AttributeKeys.remoteAddress).flatMap(_.toOption).map(_.getHostAddress).getOrElse("")
    val own = request.uri.scheme
    if (!TrustedProxies.contains(peer)) Origin(peer, own)
    else {
      val proto = request.headers.find(_.is("x-forwarded-proto")).map(_.value)
      val xff = request.headers.filter(_.is("x-forwarded-for")).map(_.value)
      Origin(clientIp(peer, xff), proto.map(_.split(",").head.trim.toLowerCase).getOrElse(own))
    }
  }

  val api: Route = concat(
    path("whoami") {
      get {
        extractRequest { request =>
          val o = resolve(request)
          complete(HttpEntity(ContentTypes.\`application/json\`, s"""{"client_ip":"\${o.clientIp}","scheme":"\${o.scheme}"}"""))
        }
      }
    },
    path("healthz") {
      get {
        complete("ok")
      }
    },
    path("orders") {
      post {
        entity(as[String]) { body =>
          val id = orders.synchronized { orders += body; orders.size }
          complete(StatusCodes.Created, HttpEntity(ContentTypes.\`application/json\`, s"""{"id":$id}"""))
        }
      }
    },
  )

  val route: Route = extractRequest { request =>
    val origin = resolve(request)
    val uri = request.uri
    if (origin.scheme != "https" && uri.path.toString != "/healthz") {
      val host = request.headers.find(_.is("host")).map(_.value).getOrElse(uri.authority.toString)
      val target = s"https://$host\${uri.path}" + uri.rawQueryString.map("?" + _).getOrElse("")
      // not the redirect directive: it adds an HTML body
      complete(HttpResponse(StatusCodes.PermanentRedirect, headers = List(Location(Uri(target)))))
    } else if (origin.scheme == "https")
      // sealed inside, so a rejection becomes a 404 response the header can join
      respondWithHeader(RawHeader("Strict-Transport-Security", Hsts))(Route.seal(api))
    else api
  }

  def main(args: Array[String]): Unit = {
    // pekko.http.server.remote-address-attribute = on
    implicit val system: ActorSystem = ActorSystem("proxy-aware")
    // plain HTTP: TLS ends at the load balancer
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>

#include <algorithm>
#include <cctype>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

const std::set<std::string> kTrustedProxies = {"10.0.0.2", "10.0.0.3"};
const std::string kHsts = "max-age=63072000; includeSubDomains";

std::mutex orders_mu;
std::vector<std::string> orders;

struct Origin {
  std::string client_ip;
  std::string scheme;
};

// The client's address and scheme as the client saw them.
Origin resolve(const httplib::Request& req) {
  // TODO: only when the peer is in kTrustedProxies: the scheme from X-Forwarded-Proto (first value,
  // lowercased) and the client from X-Forwarded-For (right to left, skipping kTrustedProxies)
  return {req.remote_addr, "http"};
}

int main() {
  httplib::Server svr;
  // TODO: pre-routing: effective http on any path but /healthz → 308, Location: https://<Host><path>[?query]
  // TODO: post-routing: effective https → Strict-Transport-Security: kHsts

  svr.Get("/whoami", [](const httplib::Request& req, httplib::Response& res) {
    const Origin o = resolve(req);
    res.set_content(R"({"client_ip":")" + o.client_ip + R"(","scheme":")" + o.scheme + R"("})", "application/json");
  });
  svr.Get("/healthz", [](const httplib::Request&, httplib::Response& res) { res.set_content("ok", "text/plain"); });
  svr.Post("/orders", [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(orders_mu);
    orders.push_back(req.body);
    res.status = 201;
    res.set_content(R"({"id":)" + std::to_string(orders.size()) + "}", "application/json");
  });
  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `#include <httplib.h>

#include <algorithm>
#include <cctype>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

const std::set<std::string> kTrustedProxies = {"10.0.0.2", "10.0.0.3"};
const std::string kHsts = "max-age=63072000; includeSubDomains";

std::mutex orders_mu;
std::vector<std::string> orders;

struct Origin {
  std::string client_ip;
  std::string scheme;
};

std::string trim(const std::string& s) {
  const auto begin = s.find_first_not_of(" \\t");
  if (begin == std::string::npos) return "";
  return s.substr(begin, s.find_last_not_of(" \\t") - begin + 1);
}

// Right to left through X-Forwarded-For: the first hop that is not one of ours is the client.
std::string client_ip(const std::string& peer, const std::string& xff) {
  std::vector<std::string> hops;
  std::stringstream in(xff);
  for (std::string hop; std::getline(in, hop, ',');)
    if (!trim(hop).empty()) hops.push_back(trim(hop));
  for (auto it = hops.rbegin(); it != hops.rend(); ++it)
    if (!kTrustedProxies.count(*it)) return *it;
  return hops.empty() ? peer : hops.front();
}

// The client's address and scheme. Headers count only when our own proxy sent them.
Origin resolve(const httplib::Request& req) {
  const std::string peer = req.remote_addr;
  if (!kTrustedProxies.count(peer)) return {peer, "http"};  // a plain listener: the own scheme is http
  std::string scheme = "http";
  if (req.has_header("X-Forwarded-Proto")) {
    const std::string proto = req.get_header_value("X-Forwarded-Proto");
    scheme = trim(proto.substr(0, proto.find(',')));
    std::transform(scheme.begin(), scheme.end(), scheme.begin(), [](unsigned char c) { return std::tolower(c); });
  }
  return {client_ip(peer, req.get_header_value("X-Forwarded-For")), scheme};
}

int main() {
  httplib::Server svr;  // plain HTTP: TLS ends at the load balancer

  svr.set_pre_routing_handler([](const httplib::Request& req, httplib::Response& res) {
    if (resolve(req).scheme != "https" && req.path != "/healthz") {
      res.status = 308;  // the client repeats the same method and body
      res.set_header("Location", "https://" + req.get_header_value("Host") + req.target);  // target keeps the query
      return httplib::Server::HandlerResponse::Handled;
    }
    return httplib::Server::HandlerResponse::Unhandled;
  });
  // runs for every response, the 404s included
  svr.set_post_routing_handler([](const httplib::Request& req, httplib::Response& res) {
    if (resolve(req).scheme == "https") res.set_header("Strict-Transport-Security", kHsts);
  });

  svr.Get("/whoami", [](const httplib::Request& req, httplib::Response& res) {
    const Origin o = resolve(req);
    res.set_content(R"({"client_ip":")" + o.client_ip + R"(","scheme":")" + o.scheme + R"("})", "application/json");
  });
  svr.Get("/healthz", [](const httplib::Request&, httplib::Response& res) { res.set_content("ok", "text/plain"); });
  svr.Post("/orders", [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(orders_mu);
    orders.push_back(req.body);
    res.status = 201;
    res.set_content(R"({"id":)" + std::to_string(orders.size()) + "}", "application/json");
  });
  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  harness: {
    python: `import httpx

HOST = "shop.example.com"
LB = "10.0.0.2"
LB2 = "10.0.0.3"
OUTSIDE = "198.51.100.23"
HSTS = "max-age=63072000; includeSubDomains"


def _load(ctx):
    m = ctx.load("proxy_aware")
    m.ORDERS.clear()
    return m


def _peer(m, ip):
    """A client whose connection comes from ip, as the load balancer's would."""
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=m.app, client=(ip, 51234)),
        base_url="http://service",
        headers={"host": HOST},
    )


def _hsts(r):
    return r.headers.get("strict-transport-security")


async def _whoami(m, peer, xff, proto="https"):
    headers = {"x-forwarded-proto": proto}
    if xff is not None:
        headers["x-forwarded-for"] = xff
    async with _peer(m, peer) as c:
        r = await c.get("/whoami", headers=headers)
    assert r.status_code == 200, f"GET /whoami from {peer} with X-Forwarded-Proto: {proto} answered {r.status_code}, expected 200"
    return r.json()


async def check_https_via_proxy(ctx):
    m = _load(ctx)
    async with _peer(m, LB) as c:
        r = await c.get("/whoami", headers={"x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7"})
        assert r.status_code == 200, f"GET /whoami from the proxy {LB} with X-Forwarded-Proto: https answered {r.status_code}, expected 200: the client used https"
        body = r.json()
        assert body == {"client_ip": "203.0.113.7", "scheme": "https"}, f'/whoami answered {body}, expected {{"client_ip": "203.0.113.7", "scheme": "https"}}'
        r = await c.get("/whoami", headers={"x-forwarded-proto": "HTTPS, http"})
        assert r.status_code == 200, f"X-Forwarded-Proto: HTTPS, http answered {r.status_code}: the first value, lowercased, is https"
        body = r.json()
        assert body == {"client_ip": LB, "scheme": "https"}, f'with no X-Forwarded-For /whoami answered {body}, expected {{"client_ip": "{LB}", "scheme": "https"}} (the client is the peer)'
    async with _peer(m, LB2) as c:
        r = await c.post("/orders", json={"sku": "A-1", "qty": 2}, headers={"x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7"})
    assert r.status_code == 201, f"POST /orders over https through {LB2} answered {r.status_code}, expected 201"
    assert m.ORDERS == [{"sku": "A-1", "qty": 2}], f"ORDERS is {m.ORDERS}, expected the one order just posted"


async def check_redirect_308(ctx):
    m = _load(ctx)
    async with _peer(m, OUTSIDE) as c:
        r = await c.get("/whoami?verbose=1&ref=mail")
        assert r.status_code == 308, f"GET /whoami over plain http answered {r.status_code}, expected 308 (301 lets a client turn a POST into a GET)"
        want = f"https://{HOST}/whoami?verbose=1&ref=mail"
        assert r.headers.get("location") == want, f"Location is {r.headers.get('location')!r}, expected {want!r}: https, the Host header, the path, the query"
        assert r.content == b"", f"the 308 has a body ({r.text[:60]!r}): send it empty"
        r = await c.get("/whoami")
        want = f"https://{HOST}/whoami"
        assert r.headers.get("location") == want, f"with no query Location is {r.headers.get('location')!r}, expected {want!r} (no trailing ?)"
    async with _peer(m, LB) as c:
        r = await c.post("/orders?ref=mail", json={"sku": "A-1", "qty": 2}, headers={"x-forwarded-proto": "http"})
    assert r.status_code == 308, f"POST /orders forwarded by {LB} as X-Forwarded-Proto: http answered {r.status_code}, expected 308"
    want = f"https://{HOST}/orders?ref=mail"
    assert r.headers.get("location") == want, f"Location is {r.headers.get('location')!r}, expected {want!r}"
    assert m.ORDERS == [], f"the redirected POST still recorded {m.ORDERS}: redirect before the handler runs"


async def check_untrusted_spoof(ctx):
    m = _load(ctx)
    forged = {"x-forwarded-proto": "https", "x-forwarded-for": "10.0.0.2"}
    async with _peer(m, OUTSIDE) as c:
        r = await c.get("/whoami", headers=forged)
        assert r.status_code == 308, f"{OUTSIDE} sent X-Forwarded-Proto: https and got {r.status_code}: it is not a trusted proxy, so the request is plain http and gets 308"
        assert _hsts(r) is None, "a forged X-Forwarded-Proto earned HSTS on plain http"
        r = await c.post("/orders", json={"sku": "A-1", "qty": 1}, headers=forged)
        assert r.status_code == 308, f"a POST /orders from {OUTSIDE} with forged headers answered {r.status_code}, expected 308"
    assert m.ORDERS == [], f"a forged https POST was recorded: {m.ORDERS}"
    async with _peer(m, "10.0.0.20") as c:
        r = await c.get("/whoami", headers={"x-forwarded-proto": "https"})
    assert r.status_code == 308, f"peer 10.0.0.20 is not in TRUSTED_PROXIES but its X-Forwarded-Proto was trusted ({r.status_code}): match the address exactly"


async def check_xff_walk(ctx):
    m = _load(ctx)
    cases = [
        (LB, "1.2.3.4, 203.0.113.7, 10.0.0.3", "203.0.113.7"),
        (LB, "203.0.113.7,10.0.0.3,10.0.0.2", "203.0.113.7"),
        (LB2, "10.0.0.3, 10.0.0.2", "10.0.0.3"),
        (LB2, "198.51.100.4", "198.51.100.4"),
    ]
    for peer, xff, want in cases:
        body = await _whoami(m, peer, xff)
        got = body.get("client_ip")
        hint = " (the leftmost hop is whatever the client wrote: walk right to left)" if got == xff.split(",")[0].strip() and got != want else ""
        assert got == want, f"through {peer}, X-Forwarded-For: {xff} gave client_ip {got!r}, expected {want!r}{hint}"


async def check_hsts(ctx):
    m = _load(ctx)
    async with _peer(m, LB) as c:
        r = await c.get("/no-such-route", headers={"x-forwarded-proto": "https"})
        assert r.status_code == 404, f"an https GET /no-such-route answered {r.status_code}, expected 404"
        assert _hsts(r) == HSTS, f"the https 404 carries Strict-Transport-Security {_hsts(r)!r}, expected {HSTS!r}: every https response needs it"
        r = await c.get("/whoami", headers={"x-forwarded-proto": "https"})
        assert _hsts(r) == HSTS, f"the https /whoami carries Strict-Transport-Security {_hsts(r)!r}, expected {HSTS!r}"
        r = await c.get("/whoami", headers={"x-forwarded-proto": "http"})
        assert _hsts(r) is None, f"the plain-http 308 carries Strict-Transport-Security: {_hsts(r)!r}; RFC 6797 7.2 forbids it over http"
    async with _peer(m, OUTSIDE) as c:
        r = await c.get("/healthz")
    assert _hsts(r) is None, f"an http /healthz carries Strict-Transport-Security: {_hsts(r)!r}; send it only over https"


async def check_healthz_exempt(ctx):
    m = _load(ctx)
    for peer, headers in ((OUTSIDE, {}), (LB, {"x-forwarded-proto": "http"})):
        async with _peer(m, peer) as c:
            r = await c.get("/healthz", headers=headers)
        assert r.status_code == 200, f"GET /healthz over plain http from {peer} answered {r.status_code}, expected 200: the load balancer probes it without TLS"
        assert r.headers.get("location") is None, f"GET /healthz from {peer} carries Location {r.headers.get('location')!r}"
        assert r.text == "ok", f"GET /healthz answered {r.text!r}, expected 'ok'"
`,
    typescript: `const HOST = 'shop.example.com';
const LB = '10.0.0.2';
const LB2 = '10.0.0.3';
const OUTSIDE = '198.51.100.23';
const HSTS = 'max-age=63072000; includeSubDomains';

function load(ctx) {
  const m = ctx.load('proxy_aware');
  m.ORDERS.length = 0;
  return m;
}

/** A request whose connection comes from peer, as the load balancer's would. */
const send = (ctx, m, peer: string, method: string, url: string, headers: Record<string, string> = {}, json?: unknown) =>
  ctx.client(m.app).request(method, url, {headers: {host: HOST, ...headers}, remoteAddress: peer, json});

const hsts = (r): string | undefined => r.headers['strict-transport-security'];

export async function check_https_via_proxy(ctx) {
  const m = load(ctx);
  let r = await send(ctx, m, LB, 'GET', '/whoami', {'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7'});
  assert.equal(r.status, 200, \`GET /whoami from the proxy \${LB} with X-Forwarded-Proto: https answered \${r.status}, expected 200: the client used https\`);
  assert.deepEqual(r.json(), {client_ip: '203.0.113.7', scheme: 'https'}, \`/whoami answered \${r.text}, expected {"client_ip": "203.0.113.7", "scheme": "https"}\`);
  r = await send(ctx, m, LB, 'GET', '/whoami', {'x-forwarded-proto': 'HTTPS, http'});
  assert.equal(r.status, 200, \`X-Forwarded-Proto: HTTPS, http answered \${r.status}: the first value, lowercased, is https\`);
  assert.deepEqual(r.json(), {client_ip: LB, scheme: 'https'}, \`with no X-Forwarded-For /whoami answered \${r.text}, expected {"client_ip": "\${LB}", "scheme": "https"} (the client is the peer)\`);
  r = await send(ctx, m, LB2, 'POST', '/orders', {'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7'}, {sku: 'A-1', qty: 2});
  assert.equal(r.status, 201, \`POST /orders over https through \${LB2} answered \${r.status}, expected 201\`);
  assert.deepEqual(m.ORDERS, [{sku: 'A-1', qty: 2}], \`ORDERS is \${JSON.stringify(m.ORDERS)}, expected the one order just posted\`);
}

export async function check_redirect_308(ctx) {
  const m = load(ctx);
  let r = await send(ctx, m, OUTSIDE, 'GET', '/whoami?verbose=1&ref=mail');
  assert.equal(r.status, 308, \`GET /whoami over plain http answered \${r.status}, expected 308 (301 lets a client turn a POST into a GET)\`);
  let want = \`https://\${HOST}/whoami?verbose=1&ref=mail\`;
  assert.equal(r.headers.location, want, \`Location is \${JSON.stringify(r.headers.location)}, expected \${want}: https, the Host header, the path, the query\`);
  assert.equal(r.text, '', \`the 308 has a body (\${JSON.stringify(r.text.slice(0, 60))}): send it empty\`);
  r = await send(ctx, m, OUTSIDE, 'GET', '/whoami');
  want = \`https://\${HOST}/whoami\`;
  assert.equal(r.headers.location, want, \`with no query Location is \${JSON.stringify(r.headers.location)}, expected \${want} (no trailing ?)\`);
  r = await send(ctx, m, LB, 'POST', '/orders?ref=mail', {'x-forwarded-proto': 'http'}, {sku: 'A-1', qty: 2});
  assert.equal(r.status, 308, \`POST /orders forwarded by \${LB} as X-Forwarded-Proto: http answered \${r.status}, expected 308\`);
  want = \`https://\${HOST}/orders?ref=mail\`;
  assert.equal(r.headers.location, want, \`Location is \${JSON.stringify(r.headers.location)}, expected \${want}\`);
  assert.deepEqual(m.ORDERS, [], \`the redirected POST still recorded \${JSON.stringify(m.ORDERS)}: redirect before the handler runs\`);
}

export async function check_untrusted_spoof(ctx) {
  const m = load(ctx);
  const forged = {'x-forwarded-proto': 'https', 'x-forwarded-for': '10.0.0.2'};
  let r = await send(ctx, m, OUTSIDE, 'GET', '/whoami', forged);
  assert.equal(r.status, 308, \`\${OUTSIDE} sent X-Forwarded-Proto: https and got \${r.status}: it is not a trusted proxy, so the request is plain http and gets 308\`);
  assert.equal(hsts(r), undefined, 'a forged X-Forwarded-Proto earned HSTS on plain http');
  r = await send(ctx, m, OUTSIDE, 'POST', '/orders', forged, {sku: 'A-1', qty: 1});
  assert.equal(r.status, 308, \`a POST /orders from \${OUTSIDE} with forged headers answered \${r.status}, expected 308\`);
  assert.deepEqual(m.ORDERS, [], \`a forged https POST was recorded: \${JSON.stringify(m.ORDERS)}\`);
  r = await send(ctx, m, '10.0.0.20', 'GET', '/whoami', {'x-forwarded-proto': 'https'});
  assert.equal(r.status, 308, \`peer 10.0.0.20 is not in TRUSTED_PROXIES but its X-Forwarded-Proto was trusted (\${r.status}): match the address exactly\`);
}

export async function check_xff_walk(ctx) {
  const m = load(ctx);
  const cases: [string, string, string][] = [
    [LB, '1.2.3.4, 203.0.113.7, 10.0.0.3', '203.0.113.7'],
    [LB, '203.0.113.7,10.0.0.3,10.0.0.2', '203.0.113.7'],
    [LB2, '10.0.0.3, 10.0.0.2', '10.0.0.3'],
    [LB2, '198.51.100.4', '198.51.100.4'],
  ];
  for (const [peer, xff, want] of cases) {
    const r = await send(ctx, m, peer, 'GET', '/whoami', {'x-forwarded-proto': 'https', 'x-forwarded-for': xff});
    assert.equal(r.status, 200, \`GET /whoami from \${peer} with X-Forwarded-Proto: https answered \${r.status}, expected 200\`);
    const got = r.json().client_ip;
    const hint = got === xff.split(',')[0].trim() && got !== want ? ' (the leftmost hop is whatever the client wrote: walk right to left)' : '';
    assert.equal(got, want, \`through \${peer}, X-Forwarded-For: \${xff} gave client_ip \${JSON.stringify(got)}, expected \${want}\${hint}\`);
  }
}

export async function check_hsts(ctx) {
  const m = load(ctx);
  let r = await send(ctx, m, LB, 'GET', '/no-such-route', {'x-forwarded-proto': 'https'});
  assert.equal(r.status, 404, \`an https GET /no-such-route answered \${r.status}, expected 404\`);
  assert.equal(hsts(r), HSTS, \`the https 404 carries Strict-Transport-Security \${JSON.stringify(hsts(r))}, expected \${HSTS}: every https response needs it\`);
  r = await send(ctx, m, LB, 'GET', '/whoami', {'x-forwarded-proto': 'https'});
  assert.equal(hsts(r), HSTS, \`the https /whoami carries Strict-Transport-Security \${JSON.stringify(hsts(r))}, expected \${HSTS}\`);
  r = await send(ctx, m, LB, 'GET', '/whoami', {'x-forwarded-proto': 'http'});
  assert.equal(hsts(r), undefined, \`the plain-http 308 carries Strict-Transport-Security: \${JSON.stringify(hsts(r))}; RFC 6797 7.2 forbids it over http\`);
  r = await send(ctx, m, OUTSIDE, 'GET', '/healthz');
  assert.equal(hsts(r), undefined, \`an http /healthz carries Strict-Transport-Security: \${JSON.stringify(hsts(r))}; send it only over https\`);
}

export async function check_healthz_exempt(ctx) {
  const m = load(ctx);
  for (const [peer, headers] of [[OUTSIDE, {}], [LB, {'x-forwarded-proto': 'http'}]] as [string, Record<string, string>][]) {
    const r = await send(ctx, m, peer, 'GET', '/healthz', headers);
    assert.equal(r.status, 200, \`GET /healthz over plain http from \${peer} answered \${r.status}, expected 200: the load balancer probes it without TLS\`);
    assert.equal(r.headers.location, undefined, \`GET /healthz from \${peer} carries Location \${JSON.stringify(r.headers.location)}\`);
    assert.equal(r.text, 'ok', \`GET /healthz answered \${JSON.stringify(r.text)}, expected 'ok'\`);
  }
}
`,
    go: `package main

import (
	"net/http"
	"strings"

	"leetbuild/harness"
)

const (
	fwdHost    = "shop.example.com"
	fwdLB      = "10.0.0.2"
	fwdLB2     = "10.0.0.3"
	fwdOutside = "198.51.100.23"
	fwdHSTS    = "max-age=63072000; includeSubDomains"
)

// fwdSend sends a request whose connection comes from peer, as the load balancer's would; header
// pairs follow the body.
func fwdSend(c *harness.HTTP, peer, method, url string, body any, header ...string) *harness.Response {
	return c.From(peer+":40000").Do(method, url, body, append([]string{"Host", fwdHost}, header...)...)
}

// fwdHeader is a header's value, or nil when the response does not carry it.
func fwdHeader(r *harness.Response, name string) any {
	if _, ok := r.Header[http.CanonicalHeaderKey(name)]; !ok {
		return nil
	}
	return r.Header.Get(name)
}

func CheckHttpsViaProxy(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	r := fwdSend(c, fwdLB, "GET", "/whoami", nil, "X-Forwarded-Proto", "https", "X-Forwarded-For", "203.0.113.7")
	ctx.Equal(r.Status, 200, "GET /whoami from the proxy %s with X-Forwarded-Proto: https (the client used https)", fwdLB)
	ctx.Equal(r.JSON(), map[string]any{"client_ip": "203.0.113.7", "scheme": "https"}, "/whoami")
	r = fwdSend(c, fwdLB, "GET", "/whoami", nil, "X-Forwarded-Proto", "HTTPS, http")
	ctx.Equal(r.Status, 200, "X-Forwarded-Proto: HTTPS, http (the first value, lowercased, is https)")
	ctx.Equal(r.JSON(), map[string]any{"client_ip": fwdLB, "scheme": "https"}, "with no X-Forwarded-For /whoami (the client is the peer)")
	r = fwdSend(c, fwdLB2, "POST", "/orders", map[string]any{"sku": "A-1", "qty": 2}, "X-Forwarded-Proto", "https", "X-Forwarded-For", "203.0.113.7")
	ctx.Equal(r.Status, 201, "POST /orders over https through %s", fwdLB2)
	ctx.Equal(orders, []map[string]any{{"sku": "A-1", "qty": float64(2)}}, "orders must hold the one order just posted")
}

func CheckRedirect308(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	r := fwdSend(c, fwdOutside, "GET", "/whoami?verbose=1&ref=mail", nil)
	ctx.Equal(r.Status, 308, "GET /whoami over plain http (301 lets a client turn a POST into a GET)")
	want := "https://" + fwdHost + "/whoami?verbose=1&ref=mail"
	ctx.Equal(fwdHeader(r, "Location"), want, "Location: https, the Host header, the path, the query")
	body := r.Text()
	if len(body) > 60 {
		body = body[:60]
	}
	ctx.Assert(r.Text() == "", "the 308 has a body (%q): send it empty", body)
	r = fwdSend(c, fwdOutside, "GET", "/whoami", nil)
	ctx.Equal(fwdHeader(r, "Location"), "https://"+fwdHost+"/whoami", "with no query Location (no trailing ?)")
	r = fwdSend(c, fwdLB, "POST", "/orders?ref=mail", map[string]any{"sku": "A-1", "qty": 2}, "X-Forwarded-Proto", "http")
	ctx.Equal(r.Status, 308, "POST /orders forwarded by %s as X-Forwarded-Proto: http", fwdLB)
	ctx.Equal(fwdHeader(r, "Location"), "https://"+fwdHost+"/orders?ref=mail", "Location")
	ctx.Assert(len(orders) == 0, "the redirected POST still recorded %v: redirect before the handler runs", orders)
}

func CheckUntrustedSpoof(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	forged := []string{"X-Forwarded-Proto", "https", "X-Forwarded-For", "10.0.0.2"}
	r := fwdSend(c, fwdOutside, "GET", "/whoami", nil, forged...)
	ctx.Equal(r.Status, 308, "%s sent X-Forwarded-Proto: https; it is not a trusted proxy, so the request is plain http and gets 308", fwdOutside)
	ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), nil, "a forged X-Forwarded-Proto earned HSTS on plain http")
	r = fwdSend(c, fwdOutside, "POST", "/orders", map[string]any{"sku": "A-1", "qty": 1}, forged...)
	ctx.Equal(r.Status, 308, "a POST /orders from %s with forged headers", fwdOutside)
	ctx.Assert(len(orders) == 0, "a forged https POST was recorded: %v", orders)
	r = fwdSend(c, "10.0.0.20", "GET", "/whoami", nil, "X-Forwarded-Proto", "https")
	ctx.Equal(r.Status, 308, "peer 10.0.0.20 is not in trustedProxies but its X-Forwarded-Proto was trusted: match the address exactly")
}

func CheckXffWalk(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	for _, tc := range [][3]string{
		{fwdLB, "1.2.3.4, 203.0.113.7, 10.0.0.3", "203.0.113.7"},
		{fwdLB, "203.0.113.7,10.0.0.3,10.0.0.2", "203.0.113.7"},
		{fwdLB2, "10.0.0.3, 10.0.0.2", "10.0.0.3"},
		{fwdLB2, "198.51.100.4", "198.51.100.4"},
	} {
		peer, xff, want := tc[0], tc[1], tc[2]
		r := fwdSend(c, peer, "GET", "/whoami", nil, "X-Forwarded-Proto", "https", "X-Forwarded-For", xff)
		ctx.Equal(r.Status, 200, "GET /whoami from %s with X-Forwarded-Proto: https", peer)
		var who struct {
			ClientIP any \`json:"client_ip"\`
		}
		r.Decode(&who)
		hint := ""
		if who.ClientIP == strings.TrimSpace(strings.Split(xff, ",")[0]) && who.ClientIP != want {
			hint = " (the leftmost hop is whatever the client wrote: walk right to left)"
		}
		ctx.Equal(who.ClientIP, want, "through %s, X-Forwarded-For: %s gave client_ip%s", peer, xff, hint)
	}
}

func CheckHsts(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	r := fwdSend(c, fwdLB, "GET", "/no-such-route", nil, "X-Forwarded-Proto", "https")
	ctx.Equal(r.Status, 404, "an https GET /no-such-route")
	ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), fwdHSTS, "the https 404's Strict-Transport-Security (every https response needs it)")
	r = fwdSend(c, fwdLB, "GET", "/whoami", nil, "X-Forwarded-Proto", "https")
	ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), fwdHSTS, "the https /whoami's Strict-Transport-Security")
	r = fwdSend(c, fwdLB, "GET", "/whoami", nil, "X-Forwarded-Proto", "http")
	ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), nil, "the plain-http 308's Strict-Transport-Security (RFC 6797 7.2 forbids it over http)")
	r = fwdSend(c, fwdOutside, "GET", "/healthz", nil)
	ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), nil, "an http /healthz's Strict-Transport-Security (send it only over https)")
}

func CheckHealthzExempt(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	for _, tc := range []struct {
		peer   string
		header []string
	}{
		{fwdOutside, nil},
		{fwdLB, []string{"X-Forwarded-Proto", "http"}},
	} {
		r := fwdSend(c, tc.peer, "GET", "/healthz", nil, tc.header...)
		ctx.Equal(r.Status, 200, "GET /healthz over plain http from %s (the load balancer probes it without TLS)", tc.peer)
		ctx.Equal(fwdHeader(r, "Location"), nil, "GET /healthz from %s: Location", tc.peer)
		ctx.Equal(r.Text(), "ok", "GET /healthz body")
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string fwdHost = "shop.example.com";
const std::string fwdLB = "10.0.0.2";
const std::string fwdLB2 = "10.0.0.3";
const std::string fwdOutside = "198.51.100.23";
const std::string fwdHSTS = "max-age=63072000; includeSubDomains";
const std::optional<std::string> fwdNil;

// fwdSend sends a request whose connection comes from peer, as the load balancer's would; header
// pairs follow the body.
harness::Response fwdSend(harness::HTTP& c, const std::string& peer, const std::string& method, const std::string& url,
                          const std::string& body, std::vector<std::string> header = {}) {
  header.insert(header.begin(), {"Host", fwdHost});
  return c.From(peer).Send(method, url, body, header);
}

// fwdHeader is a header's value, or nil when the response does not carry it.
std::optional<std::string> fwdHeader(const harness::Response& r, const std::string& name) {
  if (!r.Header.count(name)) return std::nullopt;
  return r.HeaderValue(name);
}

// The orders the program recorded, each decoded (nil when it is not JSON).
std::vector<std::optional<harness::Any>> fwdOrders() {
  std::lock_guard<std::mutex> lock(orders_mu);
  std::vector<std::optional<harness::Any>> out;
  for (const auto& order : orders) out.push_back(harness::ParseJSON(order));
  return out;
}

}  // namespace

void CheckHttpsViaProxy(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  auto r = fwdSend(c, fwdLB, "GET", "/whoami", "", {"X-Forwarded-Proto", "https", "X-Forwarded-For", "203.0.113.7"});
  ctx.Equal(r.Status, 200, "GET /whoami from the proxy %s with X-Forwarded-Proto: https (the client used https)", fwdLB);
  ctx.Equal(r.JSON(), harness::ParseJSON(R"({"client_ip":"203.0.113.7","scheme":"https"})"), "/whoami");
  r = fwdSend(c, fwdLB, "GET", "/whoami", "", {"X-Forwarded-Proto", "HTTPS, http"});
  ctx.Equal(r.Status, 200, "X-Forwarded-Proto: HTTPS, http (the first value, lowercased, is https)");
  ctx.Equal(r.JSON(), harness::ParseJSON(R"({"client_ip":")" + fwdLB + R"(","scheme":"https"})"), "with no X-Forwarded-For /whoami (the client is the peer)");
  r = fwdSend(c, fwdLB2, "POST", "/orders", R"({"qty":2,"sku":"A-1"})", {"X-Forwarded-Proto", "https", "X-Forwarded-For", "203.0.113.7"});
  ctx.Equal(r.Status, 201, "POST /orders over https through %s", fwdLB2);
  ctx.Equal(fwdOrders(), harness::ParseJSON(R"([{"sku":"A-1","qty":2}])"), "orders must hold the one order just posted");
}

void CheckRedirect308(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  auto r = fwdSend(c, fwdOutside, "GET", "/whoami?verbose=1&ref=mail", "");
  ctx.Equal(r.Status, 308, "GET /whoami over plain http (301 lets a client turn a POST into a GET)");
  const std::string want = "https://" + fwdHost + "/whoami?verbose=1&ref=mail";
  ctx.Equal(fwdHeader(r, "Location"), want, "Location: https, the Host header, the path, the query");
  const std::string body = r.Text().substr(0, 60);
  ctx.Assert(r.Text() == "", "the 308 has a body (%q): send it empty", body);
  r = fwdSend(c, fwdOutside, "GET", "/whoami", "");
  ctx.Equal(fwdHeader(r, "Location"), "https://" + fwdHost + "/whoami", "with no query Location (no trailing ?)");
  r = fwdSend(c, fwdLB, "POST", "/orders?ref=mail", R"({"qty":2,"sku":"A-1"})", {"X-Forwarded-Proto", "http"});
  ctx.Equal(r.Status, 308, "POST /orders forwarded by %s as X-Forwarded-Proto: http", fwdLB);
  ctx.Equal(fwdHeader(r, "Location"), "https://" + fwdHost + "/orders?ref=mail", "Location");
  const auto recorded = fwdOrders();
  ctx.Assert(recorded.empty(), "the redirected POST still recorded %v: redirect before the handler runs", recorded);
}

void CheckUntrustedSpoof(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const std::vector<std::string> forged = {"X-Forwarded-Proto", "https", "X-Forwarded-For", "10.0.0.2"};
  auto r = fwdSend(c, fwdOutside, "GET", "/whoami", "", forged);
  ctx.Equal(r.Status, 308, "%s sent X-Forwarded-Proto: https; it is not a trusted proxy, so the request is plain http and gets 308", fwdOutside);
  ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), fwdNil, "a forged X-Forwarded-Proto earned HSTS on plain http");
  r = fwdSend(c, fwdOutside, "POST", "/orders", R"({"qty":1,"sku":"A-1"})", forged);
  ctx.Equal(r.Status, 308, "a POST /orders from %s with forged headers", fwdOutside);
  const auto recorded = fwdOrders();
  ctx.Assert(recorded.empty(), "a forged https POST was recorded: %v", recorded);
  r = fwdSend(c, "10.0.0.20", "GET", "/whoami", "", {"X-Forwarded-Proto", "https"});
  ctx.Equal(r.Status, 308, "peer 10.0.0.20 is not in trustedProxies but its X-Forwarded-Proto was trusted: match the address exactly");
}

void CheckXffWalk(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const std::vector<std::vector<std::string>> cases = {
      {fwdLB, "1.2.3.4, 203.0.113.7, 10.0.0.3", "203.0.113.7"},
      {fwdLB, "203.0.113.7,10.0.0.3,10.0.0.2", "203.0.113.7"},
      {fwdLB2, "10.0.0.3, 10.0.0.2", "10.0.0.3"},
      {fwdLB2, "198.51.100.4", "198.51.100.4"},
  };
  for (const auto& tc : cases) {
    const std::string &peer = tc[0], &xff = tc[1], &want = tc[2];
    const auto r = fwdSend(c, peer, "GET", "/whoami", "", {"X-Forwarded-Proto", "https", "X-Forwarded-For", xff});
    ctx.Equal(r.Status, 200, "GET /whoami from %s with X-Forwarded-Proto: https", peer);
    const auto who = harness::ParseJSON(r.Text());
    const harness::Any clientIP = who && who->IsObject() ? (*who)["client_ip"] : harness::Any();
    std::string first = xff.substr(0, xff.find(','));
    first = first.substr(first.find_first_not_of(' '));
    first = first.substr(0, first.find_last_not_of(' ') + 1);
    std::string hint;
    if (clientIP == first && !(clientIP == want)) hint = " (the leftmost hop is whatever the client wrote: walk right to left)";
    ctx.Equal(clientIP, want, "through %s, X-Forwarded-For: %s gave client_ip%s", peer, xff, hint);
  }
}

void CheckHsts(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  auto r = fwdSend(c, fwdLB, "GET", "/no-such-route", "", {"X-Forwarded-Proto", "https"});
  ctx.Equal(r.Status, 404, "an https GET /no-such-route");
  ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), fwdHSTS, "the https 404's Strict-Transport-Security (every https response needs it)");
  r = fwdSend(c, fwdLB, "GET", "/whoami", "", {"X-Forwarded-Proto", "https"});
  ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), fwdHSTS, "the https /whoami's Strict-Transport-Security");
  r = fwdSend(c, fwdLB, "GET", "/whoami", "", {"X-Forwarded-Proto", "http"});
  ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), fwdNil, "the plain-http 308's Strict-Transport-Security (RFC 6797 7.2 forbids it over http)");
  r = fwdSend(c, fwdOutside, "GET", "/healthz", "");
  ctx.Equal(fwdHeader(r, "Strict-Transport-Security"), fwdNil, "an http /healthz's Strict-Transport-Security (send it only over https)");
}

void CheckHealthzExempt(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const std::vector<std::pair<std::string, std::vector<std::string>>> cases = {
      {fwdOutside, {}},
      {fwdLB, {"X-Forwarded-Proto", "http"}},
  };
  for (const auto& [peer, header] : cases) {
    const auto r = fwdSend(c, peer, "GET", "/healthz", "", header);
    ctx.Equal(r.Status, 200, "GET /healthz over plain http from %s (the load balancer probes it without TLS)", peer);
    ctx.Equal(fwdHeader(r, "Location"), fwdNil, "GET /healthz from %s: Location", peer);
    ctx.Equal(r.Text(), "ok", "GET /healthz body");
  }
}
`,
  },
  debrief: `The whole drill is one function, \`resolve\`, and its first line: is the peer one of ours? A forwarded header is a claim made by whoever opened the connection, so it is worth exactly as much as that party. From \`10.0.0.2\` it is the load balancer reporting what it saw on the TLS side; from anyone else it is text the client typed. That is why the peer comes from the socket (\`request.client.host\`, \`request.ip\` without \`trustProxy\`, \`r.RemoteAddr\`, Pekko's remote-address attribute, \`req.remote_addr\`) and never from a helper such as Pekko's \`extractClientIP\` that reads the headers itself.

\`X-Forwarded-For\` is appended to, never rewritten: each proxy adds the address it received the connection from. So the trustworthy part is a suffix, and the client is the first hop from the right that you did not put there. The leftmost entry, which Fastify's \`trustProxy: true\` and many hand-rolled parsers return, is whatever the client sent in its own header.

The redirect goes before any handler so a plain-http \`POST\` changes nothing, and it is a 308 because 301 and 302 let clients replay a \`POST\` as a \`GET\`. HSTS is added after routing, so 404s carry it, and only on https, because a header received over plain http could have been injected by anyone on the path. \`/healthz\` is exempt because the load balancer probes it over the internal hop.

Real stacks add the trust list as configuration (uvicorn \`--forwarded-allow-ips\`, Fastify \`trustProxy: ['10.0.0.2', '10.0.0.3']\`, nginx \`set_real_ip_from\` with \`real_ip_recursive on\`), CIDR ranges instead of single addresses, RFC 7239 \`Forwarded\` parsing, \`X-Forwarded-Host\` for the redirect, and the HSTS \`preload\` directive once every subdomain is on https.`,
};
