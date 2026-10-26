import type {Step} from '@/lib/types';

export const corsPreflightStep: Step = {
  id: 'cors-preflight',
  title: 'CORS by hand: preflight, allowlist, Vary',
  concept: 'http',
  file: 'cors',
  focus: ['client', 'notes'],
  task: `## Task

The notes API already serves its three routes. Add CORS to every \`/api/...\` path, by hand, with no CORS
library.

| Route | Answer |
|---|---|
| \`GET /api/notes\` | 200, JSON list |
| \`POST /api/notes\` | 201, the new note |
| \`DELETE /api/notes/{id}\` | 204 |

Constants: \`ALLOWED_ORIGINS = {"https://app.example.com", "https://admin.example.com"}\`, \`ALLOWED_METHODS\`
\`GET, POST, DELETE\`, \`ALLOWED_HEADERS = {"authorization", "content-type"}\`, \`MAX_AGE = 600\`.

**Preflight**: an \`OPTIONS\` request to an \`/api/...\` path that carries both \`Origin\` and
\`Access-Control-Request-Method\`.

- **Allowed** when the origin is in \`ALLOWED_ORIGINS\` (exact match), the method is in \`ALLOWED_METHODS\`,
  and every name in \`Access-Control-Request-Headers\` (comma list, trimmed, case-insensitive) is in
  \`ALLOWED_HEADERS\`.
- Any other preflight answers **403** with no \`Access-Control-*\` header at all.

An allowed preflight answers **204** with an empty body and these headers:

| Header | Value |
|---|---|
| \`Access-Control-Allow-Origin\` | the request's \`Origin\` |
| \`Access-Control-Allow-Methods\` | \`GET, POST, DELETE\` |
| \`Access-Control-Allow-Headers\` | the requested names, lowercased, in the order sent, joined with a comma and a space; omitted when none were requested |
| \`Access-Control-Allow-Credentials\` | \`true\` |
| \`Access-Control-Max-Age\` | \`600\` |
| \`Vary\` | \`Origin, Access-Control-Request-Method, Access-Control-Request-Headers\` |

**Actual requests** to \`/api/...\`:

- Always carry \`Vary: Origin\`, whatever the \`Origin\`.
- With an allowed \`Origin\`, also \`Access-Control-Allow-Origin: <the origin>\` and
  \`Access-Control-Allow-Credentials: true\`. Never \`*\`.
- A disallowed or missing \`Origin\` still gets the normal status and body, without
  \`Access-Control-Allow-Origin\` or \`Access-Control-Allow-Credentials\`.

Python: one \`@app.middleware("http")\` that answers preflights before routing (FastAPI would answer an
undeclared \`OPTIONS\` with 405). TypeScript: an \`onRequest\` hook for actual requests and an
\`options('/api/*')\` route for preflights.

> The server only declares who may read its responses; the browser enforces it. So a disallowed origin
> still gets a normal answer, and the one thing the server must never do is grant an origin it did not find
> in the allowlist.`,
  sequence: {
    participants: ['Browser', 'notes'],
    messages: [
      {
        from: 'Browser',
        to: 'notes',
        label: 'OPTIONS · Origin: app · ACR-Method: POST',
        kind: 'sync',
      },
      {
        from: 'notes',
        to: 'Browser',
        label: '204 · grant · Max-Age: 600',
        kind: 'reply',
      },
      {from: 'Browser', to: 'notes', label: 'POST /api/notes · Cookie', kind: 'sync'},
      {
        from: 'notes',
        to: 'Browser',
        label: '201 · Allow-Origin: app · Vary: Origin',
        kind: 'reply',
      },
      {from: 'Browser', to: 'notes', label: 'OPTIONS · Origin: evil', kind: 'sync'},
      {from: 'notes', to: 'Browser', label: '403 · no grant · POST never sent', kind: 'reply'},
    ],
  },
  hints: [
    'A preflight is `OPTIONS` plus `Origin` plus `Access-Control-Request-Method`. Catch it before routing (a FastAPI middleware, a Fastify `options` route on `/api/*`) and answer it yourself; everything else goes to the routes.',
    'Parse `Access-Control-Request-Headers` by splitting on commas, trimming, lowercasing and dropping empty names. The preflight is allowed only if every name is in `ALLOWED_HEADERS`; echo that same list back, joined with `, `.',
    'For actual requests set `Vary: Origin` first, unconditionally, then add the grant only after an exact set lookup of the `Origin`. Echoing the request `Origin` without the lookup is the reflect-any-origin bug; `*` is refused by browsers once credentials are involved.',
  ],
  checks: [
    {
      id: 'preflight',
      title: 'An allowed preflight answers 204 with the grant',
      detail:
        '`OPTIONS` with an allowed `Origin` and method answers 204, empty body, with `Access-Control-Allow-Origin` (the origin), `Allow-Methods: GET, POST, DELETE`, `Allow-Credentials: true` and `Max-Age: 600`, written by hand: no CORS library.',
      match: {
        python: {
          all: [
            /@app\.middleware\(\s*["']http["']\s*\)/,
            /access-control-request-method/i,
            /status_code\s*=\s*204/,
            /Access-Control-Max-Age/i,
          ],
          none: [/CORSMiddleware|fastapi\.middleware\.cors|starlette\.middleware\.cors/],
        },
        typescript: {
          all: [
            /\.options\(\s*['"]\/api\/\*['"]/,
            /access-control-request-method/i,
            /code\(\s*204\s*\)/,
            /Access-Control-Max-Age/i,
          ],
          none: [/@fastify\/cors|fastify-cors|from\s+['"]cors['"]/],
        },
        go: {
          all: [
            /http\.MethodOptions|"OPTIONS"/,
            /Access-Control-Request-Method/,
            /http\.StatusNoContent/,
            /Access-Control-Max-Age/,
          ],
          none: [/rs\/cors|gorilla\/handlers|handlers\.CORS|cors\.(New|Default|AllowAll)\(/],
        },
        scala: {
          all: [/\boptions\s*\{/, /Access-Control-Request-Method/, /StatusCodes\.NoContent/, /Access-Control-Max-Age/],
          none: [/http\.cors|megard|CorsSettings|\bcors\s*\(/],
        },
        cpp: {
          all: [/svr\.Options\(/, /Access-Control-Request-Method/, /status\s*=\s*204/, /Access-Control-Max-Age/],
          none: [/CORSHandler|crow::|drogon::|#include\s*[<"][^>"\n]*cors/i],
        },
      },
    },
    {
      id: 'allow-headers',
      title: 'Requested headers are checked, then echoed lowercased',
      detail:
        '`Access-Control-Request-Headers` is split on commas, trimmed and lowercased; every name must be in `ALLOWED_HEADERS` or the preflight is a 403. `Access-Control-Allow-Headers` echoes the names in the order sent, and is omitted when none were requested.',
      match: {
        python: {
          all: [
            /access-control-request-headers/i,
            /Access-Control-Allow-Headers/i,
            /\.lower\(\)/,
            /\bin\s+ALLOWED_HEADERS\b/,
          ],
        },
        typescript: {
          all: [
            /access-control-request-headers/i,
            /Access-Control-Allow-Headers/i,
            /\.toLowerCase\(\)/,
            /ALLOWED_HEADERS\.has\(/,
          ],
        },
        go: {
          all: [
            /Access-Control-Request-Headers/,
            /Access-Control-Allow-Headers/,
            /strings\.ToLower\(/,
            /allowedHeaders\[/,
          ],
        },
        scala: {
          all: [
            /Access-Control-Request-Headers/,
            /Access-Control-Allow-Headers/,
            /toLowerCase/,
            /AllowedHeaders\.contains/,
          ],
        },
        cpp: {
          all: [
            /Access-Control-Request-Headers/,
            /Access-Control-Allow-Headers/,
            /tolower/,
            /kAllowedHeaders\.count\(/,
          ],
        },
      },
    },
    {
      id: 'rejected',
      title: 'Any other preflight answers 403 with no grant',
      detail:
        'An origin outside the allowlist (including look-alikes such as `https://app.example.com.evil.net`, `http://app.example.com` and `null`) or a method outside `GET, POST, DELETE` answers 403 with no `Access-Control-*` header.',
      match: {
        python: {all: [/status_code\s*=\s*403/, /\bin\s+ALLOWED_ORIGINS\b/, /\bin\s+ALLOWED_METHODS\b/]},
        typescript: {all: [/code\(\s*403\s*\)/, /ALLOWED_ORIGINS\.has\(/, /ALLOWED_METHODS\.includes\(/]},
        go: {all: [/http\.StatusForbidden/, /allowedOrigins\[/, /allowedMethods\[/]},
        scala: {all: [/StatusCodes\.Forbidden/, /AllowedOrigins\.contains/, /AllowedMethods\.contains/]},
        cpp: {all: [/status\s*=\s*403/, /kAllowedOrigins\.count\(/, /kAllowedMethods\.count\(/]},
      },
    },
    {
      id: 'echo-origin',
      title: 'Actual requests from an allowed origin echo it, with credentials',
      detail:
        '`GET`, `POST` and `DELETE` from an allowed `Origin` keep their 200, 201 and 204 and add `Access-Control-Allow-Origin: <origin>` and `Access-Control-Allow-Credentials: true`. Never `*`.',
      match: {
        python: {
          all: [/Access-Control-Allow-Origin/i, /Access-Control-Allow-Credentials/i, /["']true["']/],
          none: [/["']\*["']/],
        },
        typescript: {
          all: [/Access-Control-Allow-Origin/i, /Access-Control-Allow-Credentials/i, /["']true["']/],
          none: [/["']\*["']/],
        },
        go: {
          all: [/Access-Control-Allow-Origin/, /Access-Control-Allow-Credentials/, /"true"/],
          none: [/"\*"/],
        },
        scala: {
          all: [/Access-Control-Allow-Origin/, /Access-Control-Allow-Credentials/, /"true"/],
          none: [/"\*"/],
        },
        cpp: {
          all: [/Access-Control-Allow-Origin/, /Access-Control-Allow-Credentials/, /"true"/],
          none: [/"\*"/],
        },
      },
    },
    {
      id: 'vary',
      title: 'Vary names what the answer depends on',
      detail:
        'Every actual response carries `Vary: Origin`, with or without an `Origin`; an allowed preflight carries `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`. Without it a shared cache serves one origin the answer computed for another.',
      match: {
        python: {
          all: [
            /["']Vary["']\]?\s*[=:,]\s*["']Origin["']/,
            /Origin, Access-Control-Request-Method, Access-Control-Request-Headers/,
          ],
        },
        typescript: {
          all: [
            /["']Vary["']\]?\s*[=:,]\s*["']Origin["']/,
            /Origin, Access-Control-Request-Method, Access-Control-Request-Headers/,
          ],
        },
        go: {
          all: [/"Vary",\s*"Origin"/, /Origin, Access-Control-Request-Method, Access-Control-Request-Headers/],
        },
        scala: {
          all: [/"Vary",\s*"Origin"/, /Origin, Access-Control-Request-Method, Access-Control-Request-Headers/],
        },
        cpp: {
          all: [/"Vary",\s*"Origin"/, /Origin, Access-Control-Request-Method, Access-Control-Request-Headers/],
        },
      },
    },
    {
      id: 'no-origin',
      title: 'A disallowed or missing Origin gets the normal answer, ungranted',
      detail:
        'Requests without an `Origin`, or from an origin outside the allowlist, still get 200, 201 or 204 and their body, but no `Access-Control-Allow-Origin` and no `Access-Control-Allow-Credentials`: the server declares, the browser enforces.',
      match: {
        python: {all: [/\.get\(\s*["']origin["']\s*\)/i, /await\s+call_next\(\s*request\s*\)/]},
        typescript: {
          all: [
            /request\.headers\.origin\b|headers\[\s*['"]origin['"]\s*\]/,
            /addHook\(\s*['"](onRequest|onSend|preHandler)['"]/,
          ],
        },
        go: {all: [/r\.Header\.Get\(\s*"Origin"\s*\)/, /next\.ServeHTTP\(/]},
        scala: {all: [/optionalHeaderValueByName\(\s*"Origin"\s*\)/, /respondWithHeaders?\(/]},
        cpp: {all: [/get_header_value\(\s*"Origin"\s*\)/, /set_post_routing_handler\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

ALLOWED_ORIGINS = {"https://app.example.com", "https://admin.example.com"}
ALLOWED_METHODS = ("GET", "POST", "DELETE")
ALLOWED_HEADERS = {"authorization", "content-type"}
MAX_AGE = 600

NOTES: list[dict] = []


class NoteIn(BaseModel):
    text: str


@app.middleware("http")
async def cors(request: Request, call_next):
    # TODO: only /api/... paths
    # TODO: OPTIONS + Origin + Access-Control-Request-Method is a preflight: answer it here, before routing
    #       allowed (origin, method, every requested header) -> 204 with the grant, else 403 with none
    # TODO: actual requests: Vary: Origin always; echo an allowed Origin with credentials, never "*"
    return await call_next(request)


@app.get("/api/notes")
def list_notes() -> list[dict]:
    return NOTES


@app.post("/api/notes", status_code=201)
def create_note(body: NoteIn) -> dict:
    note = {"id": max((n["id"] for n in NOTES), default=0) + 1, "text": body.text}
    NOTES.append(note)
    return note


@app.delete("/api/notes/{note_id}", status_code=204)
def delete_note(note_id: int) -> Response:
    NOTES[:] = [n for n in NOTES if n["id"] != note_id]
    return Response(status_code=204)
`,
      solution: `from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

ALLOWED_ORIGINS = {"https://app.example.com", "https://admin.example.com"}
ALLOWED_METHODS = ("GET", "POST", "DELETE")
ALLOWED_HEADERS = {"authorization", "content-type"}
MAX_AGE = 600
PREFLIGHT_VARY = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"

NOTES: list[dict] = []


class NoteIn(BaseModel):
    text: str


def preflight(origin: str, method: str, raw_headers: str) -> Response:
    requested = [name.strip().lower() for name in raw_headers.split(",") if name.strip()]
    if (
        origin not in ALLOWED_ORIGINS
        or method not in ALLOWED_METHODS
        or any(name not in ALLOWED_HEADERS for name in requested)
    ):
        return JSONResponse({"error": "CORS preflight rejected"}, status_code=403, headers={"Vary": PREFLIGHT_VARY})
    headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": ", ".join(ALLOWED_METHODS),
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": str(MAX_AGE),
        "Vary": PREFLIGHT_VARY,
    }
    if requested:
        headers["Access-Control-Allow-Headers"] = ", ".join(requested)
    return Response(status_code=204, headers=headers)


@app.middleware("http")
async def cors(request: Request, call_next):
    if not request.url.path.startswith("/api/"):
        return await call_next(request)
    origin = request.headers.get("origin")
    method = request.headers.get("access-control-request-method")
    if request.method == "OPTIONS" and origin is not None and method is not None:
        # answered before routing: FastAPI has no OPTIONS route and would say 405
        return preflight(origin, method, request.headers.get("access-control-request-headers", ""))
    response = await call_next(request)
    # the answer depends on Origin even when there is none: caches must key on it
    response.headers["Vary"] = "Origin"
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
    return response


@app.get("/api/notes")
def list_notes() -> list[dict]:
    return NOTES


@app.post("/api/notes", status_code=201)
def create_note(body: NoteIn) -> dict:
    note = {"id": max((n["id"] for n in NOTES), default=0) + 1, "text": body.text}
    NOTES.append(note)
    return note


@app.delete("/api/notes/{note_id}", status_code=204)
def delete_note(note_id: int) -> Response:
    NOTES[:] = [n for n in NOTES if n["id"] != note_id]
    return Response(status_code=204)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

export const app = Fastify();

export const ALLOWED_ORIGINS = new Set(['https://app.example.com', 'https://admin.example.com']);
export const ALLOWED_METHODS = ['GET', 'POST', 'DELETE'];
export const ALLOWED_HEADERS = new Set(['authorization', 'content-type']);
export const MAX_AGE = 600;

export const notes: {id: number; text: string}[] = [];

app.addHook('onRequest', async (request, reply) => {
  // TODO: actual requests to /api/...: Vary: Origin always; echo an allowed Origin with credentials, never '*'
});

// TODO: app.options('/api/*', ...): OPTIONS + Origin + Access-Control-Request-Method is a preflight
//       allowed (origin, method, every requested header) -> 204 with the grant, else 403 with none

app.get('/api/notes', async () => notes);

app.post('/api/notes', async (request, reply) => {
  const {text} = request.body as {text: string};
  const note = {id: notes.reduce((max, n) => Math.max(max, n.id), 0) + 1, text};
  notes.push(note);
  return reply.code(201).send(note);
});

app.delete('/api/notes/:id', async (request, reply) => {
  const id = Number((request.params as {id: string}).id);
  notes.splice(0, notes.length, ...notes.filter(n => n.id !== id));
  return reply.code(204).send();
});
`,
      solution: `import Fastify from 'fastify';

export const app = Fastify();

export const ALLOWED_ORIGINS = new Set(['https://app.example.com', 'https://admin.example.com']);
export const ALLOWED_METHODS = ['GET', 'POST', 'DELETE'];
export const ALLOWED_HEADERS = new Set(['authorization', 'content-type']);
export const MAX_AGE = 600;
const PREFLIGHT_VARY = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';

export const notes: {id: number; text: string}[] = [];

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(', ') : value;

// Actual requests: the preflight route below answers OPTIONS itself.
app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/') || request.method === 'OPTIONS') return;
  reply.header('Vary', 'Origin');
  const origin = one(request.headers.origin);
  if (origin !== undefined && ALLOWED_ORIGINS.has(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
  }
});

app.options('/api/*', async (request, reply) => {
  const origin = one(request.headers.origin);
  const method = one(request.headers['access-control-request-method']);
  if (origin === undefined || method === undefined) return reply.callNotFound();
  const requested = (one(request.headers['access-control-request-headers']) ?? '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(name => name !== '');
  reply.header('Vary', PREFLIGHT_VARY);
  if (!ALLOWED_ORIGINS.has(origin) || !ALLOWED_METHODS.includes(method) || !requested.every(name => ALLOWED_HEADERS.has(name)))
    return reply.code(403).send({error: 'CORS preflight rejected'});
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
  if (requested.length > 0) reply.header('Access-Control-Allow-Headers', requested.join(', '));
  reply.header('Access-Control-Allow-Credentials', 'true');
  reply.header('Access-Control-Max-Age', String(MAX_AGE));
  return reply.code(204).send();
});

app.get('/api/notes', async () => notes);

app.post('/api/notes', async (request, reply) => {
  const {text} = request.body as {text: string};
  const note = {id: notes.reduce((max, n) => Math.max(max, n.id), 0) + 1, text};
  notes.push(note);
  return reply.code(201).send(note);
});

app.delete('/api/notes/:id', async (request, reply) => {
  const id = Number((request.params as {id: string}).id);
  notes.splice(0, notes.length, ...notes.filter(n => n.id !== id));
  return reply.code(204).send();
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

var (
	allowedOrigins = map[string]bool{"https://app.example.com": true, "https://admin.example.com": true}
	allowedMethods = map[string]bool{"GET": true, "POST": true, "DELETE": true}
	allowedHeaders = map[string]bool{"authorization": true, "content-type": true}
)

const (
	allowMethods = "GET, POST, DELETE"
	maxAge       = "600"
)

type note struct {
	ID   int    \`json:"id"\`
	Text string \`json:"text"\`
}

var (
	mu     sync.Mutex
	notes  = []note{}
	nextID = 1
)

func listNotes(rw http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(notes)
}

func createNote(rw http.ResponseWriter, r *http.Request) {
	var in note
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(rw, "bad json", http.StatusBadRequest)
		return
	}
	mu.Lock()
	in.ID = nextID
	nextID++
	notes = append(notes, in)
	mu.Unlock()
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusCreated)
	json.NewEncoder(rw).Encode(in)
}

func deleteNote(rw http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	mu.Lock()
	kept := notes[:0]
	for _, n := range notes {
		if n.ID != id {
			kept = append(kept, n)
		}
	}
	notes = kept
	mu.Unlock()
	rw.WriteHeader(http.StatusNoContent)
}

// cors wraps every route.
func cors(next http.Handler) http.Handler {
	// TODO: only /api/... paths
	// TODO: OPTIONS + Origin + Access-Control-Request-Method is a preflight: answer it here
	//       allowed (origin, method, every requested header) -> 204 with the grant, else 403 with none
	// TODO: actual requests: Vary: Origin always; echo an allowed Origin with credentials, never "*"
	_ = strings.HasPrefix
	return next
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/notes", listNotes)
	mux.HandleFunc("POST /api/notes", createNote)
	mux.HandleFunc("DELETE /api/notes/{id}", deleteNote)
	// TLS terminates at the load balancer in front of this process.
	log.Fatal(http.ListenAndServe(":8080", cors(mux)))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

var (
	allowedOrigins = map[string]bool{"https://app.example.com": true, "https://admin.example.com": true}
	allowedMethods = map[string]bool{"GET": true, "POST": true, "DELETE": true}
	allowedHeaders = map[string]bool{"authorization": true, "content-type": true}
)

const (
	allowMethods  = "GET, POST, DELETE"
	maxAge        = "600"
	preflightVary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
)

type note struct {
	ID   int    \`json:"id"\`
	Text string \`json:"text"\`
}

var (
	mu     sync.Mutex
	notes  = []note{}
	nextID = 1
)

func listNotes(rw http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(notes)
}

func createNote(rw http.ResponseWriter, r *http.Request) {
	var in note
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(rw, "bad json", http.StatusBadRequest)
		return
	}
	mu.Lock()
	in.ID = nextID
	nextID++
	notes = append(notes, in)
	mu.Unlock()
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusCreated)
	json.NewEncoder(rw).Encode(in)
}

func deleteNote(rw http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	mu.Lock()
	kept := notes[:0]
	for _, n := range notes {
		if n.ID != id {
			kept = append(kept, n)
		}
	}
	notes = kept
	mu.Unlock()
	rw.WriteHeader(http.StatusNoContent)
}

func preflight(rw http.ResponseWriter, r *http.Request, origin string) {
	h := rw.Header()
	h.Set("Vary", preflightVary)
	var requested []string
	for _, name := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
		if name = strings.ToLower(strings.TrimSpace(name)); name != "" {
			requested = append(requested, name)
		}
	}
	ok := allowedOrigins[origin] && allowedMethods[r.Header.Get("Access-Control-Request-Method")]
	for _, name := range requested {
		ok = ok && allowedHeaders[name]
	}
	if !ok {
		http.Error(rw, "CORS preflight rejected", http.StatusForbidden)
		return
	}
	h.Set("Access-Control-Allow-Origin", origin)
	h.Set("Access-Control-Allow-Methods", allowMethods)
	if len(requested) > 0 {
		h.Set("Access-Control-Allow-Headers", strings.Join(requested, ", "))
	}
	h.Set("Access-Control-Allow-Credentials", "true")
	h.Set("Access-Control-Max-Age", maxAge)
	rw.WriteHeader(http.StatusNoContent)
}

// cors wraps every route.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(rw, r)
			return
		}
		origin := r.Header.Get("Origin")
		if r.Method == http.MethodOptions && origin != "" && r.Header.Get("Access-Control-Request-Method") != "" {
			preflight(rw, r, origin)
			return
		}
		rw.Header().Add("Vary", "Origin")
		if allowedOrigins[origin] {
			rw.Header().Set("Access-Control-Allow-Origin", origin)
			rw.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		next.ServeHTTP(rw, r)
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/notes", listNotes)
	mux.HandleFunc("POST /api/notes", createNote)
	mux.HandleFunc("DELETE /api/notes/{id}", deleteNote)
	// TLS terminates at the load balancer in front of this process.
	log.Fatal(http.ListenAndServe(":8080", cors(mux)))
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

import scala.jdk.CollectionConverters._

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object NotesServer {
  val AllowedOrigins = Set("https://app.example.com", "https://admin.example.com")
  val AllowedMethods = Seq("GET", "POST", "DELETE")
  val AllowedHeaders = Set("authorization", "content-type")
  val MaxAge = 600

  private val notes = new ConcurrentHashMap[Int, String]()
  private val nextId = new AtomicInteger(1)

  private def json(body: String) = HttpEntity(ContentTypes.\`application/json\`, body)

  val notesRoute: Route =
    pathPrefix("notes") {
      concat(
        pathEndOrSingleSlash {
          concat(
            get { complete(json(notes.values.asScala.mkString("[", ",", "]"))) },
            post {
              entity(as[String]) { text =>
                val id = nextId.getAndIncrement()
                val note = s"""{"id":$id,"text":$text}"""
                notes.put(id, note)
                complete(HttpResponse(StatusCodes.Created, entity = json(note)))
              }
            },
          )
        },
        path(IntNumber) { id =>
          delete {
            notes.remove(id)
            complete(StatusCodes.NoContent)
          }
        },
      )
    }

  val route: Route =
    pathPrefix("api") {
      // TODO: OPTIONS + Origin + Access-Control-Request-Method is a preflight: answer it here
      //       allowed (origin, method, every requested header) -> 204 with the grant, else 403 with none
      // TODO: actual requests: Vary: Origin always; echo an allowed Origin with credentials, never "*"
      notesRoute
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("notes")
    // TLS terminates at the load balancer in front of this process.
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
      solution: `import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

import scala.jdk.CollectionConverters._

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object NotesServer {
  val AllowedOrigins = Set("https://app.example.com", "https://admin.example.com")
  val AllowedMethods = Seq("GET", "POST", "DELETE")
  val AllowedHeaders = Set("authorization", "content-type")
  val MaxAge = 600
  val PreflightVary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"

  private val notes = new ConcurrentHashMap[Int, String]()
  private val nextId = new AtomicInteger(1)

  private def json(body: String) = HttpEntity(ContentTypes.\`application/json\`, body)

  val notesRoute: Route =
    pathPrefix("notes") {
      concat(
        pathEndOrSingleSlash {
          concat(
            get { complete(json(notes.values.asScala.mkString("[", ",", "]"))) },
            post {
              entity(as[String]) { text =>
                val id = nextId.getAndIncrement()
                val note = s"""{"id":$id,"text":$text}"""
                notes.put(id, note)
                complete(HttpResponse(StatusCodes.Created, entity = json(note)))
              }
            },
          )
        },
        path(IntNumber) { id =>
          delete {
            notes.remove(id)
            complete(StatusCodes.NoContent)
          }
        },
      )
    }

  private def preflight(origin: String, method: String, requestHeaders: Option[String]): Route = {
    val requested = requestHeaders.toList.flatMap(_.split(",")).map(_.trim.toLowerCase).filter(_.nonEmpty)
    val vary = RawHeader("Vary", PreflightVary)
    if (!AllowedOrigins.contains(origin) || !AllowedMethods.contains(method) || !requested.forall(AllowedHeaders.contains))
      complete(HttpResponse(StatusCodes.Forbidden, headers = List(vary)))
    else {
      val allowHeaders =
        if (requested.isEmpty) Nil else List(RawHeader("Access-Control-Allow-Headers", requested.mkString(", ")))
      val grant = List(
        RawHeader("Access-Control-Allow-Origin", origin),
        RawHeader("Access-Control-Allow-Methods", AllowedMethods.mkString(", ")),
        RawHeader("Access-Control-Allow-Credentials", "true"),
        RawHeader("Access-Control-Max-Age", MaxAge.toString),
        vary,
      ) ++ allowHeaders
      complete(HttpResponse(StatusCodes.NoContent, headers = grant))
    }
  }

  private def actual(origin: Option[String]): Route = {
    val grant = origin.filter(AllowedOrigins.contains).toList.flatMap { o =>
      List(RawHeader("Access-Control-Allow-Origin", o), RawHeader("Access-Control-Allow-Credentials", "true"))
    }
    respondWithHeaders(RawHeader("Vary", "Origin") :: grant) { notesRoute }
  }

  val route: Route =
    pathPrefix("api") {
      optionalHeaderValueByName("Origin") { origin =>
        optionalHeaderValueByName("Access-Control-Request-Method") { requestMethod =>
          optionalHeaderValueByName("Access-Control-Request-Headers") { requestHeaders =>
            (origin, requestMethod) match {
              case (Some(o), Some(m)) => concat(options { preflight(o, m, requestHeaders) }, actual(origin))
              case _                  => actual(origin)
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("notes")
    // TLS terminates at the load balancer in front of this process.
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

const std::set<std::string> kAllowedOrigins = {"https://app.example.com", "https://admin.example.com"};
const std::set<std::string> kAllowedMethods = {"GET", "POST", "DELETE"};
const std::set<std::string> kAllowedHeaders = {"authorization", "content-type"};
constexpr const char* kAllowMethods = "GET, POST, DELETE";
constexpr int kMaxAge = 600;

std::mutex mu;
std::map<int, std::string> notes;  // id -> note JSON
int next_id = 1;

int main() {
  httplib::Server svr;

  svr.Get("/api/notes", [](const httplib::Request&, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    std::string body = "[";
    for (const auto& [id, note] : notes) body += (body.size() > 1 ? "," : "") + note;
    res.set_content(body + "]", "application/json");
  });

  svr.Post("/api/notes", [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    const int id = next_id++;
    const auto body = nlohmann::json::parse(req.body, nullptr, false);
    const std::string text = body.is_object() && body.contains("text") && body["text"].is_string() ? body["text"].get<std::string>() : "";
    notes[id] = nlohmann::json{{"id", id}, {"text", text}}.dump();
    res.status = 201;
    res.set_content(notes[id], "application/json");
  });

  svr.Delete(R"(/api/notes/(\\d+))", [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    notes.erase(std::stoi(req.matches[1]));
    res.status = 204;
  });

  // TODO: svr.Options on /api/...: OPTIONS + Origin + Access-Control-Request-Method is a preflight
  //       allowed (origin, method, every requested header) -> 204 with the grant, else 403 with none
  // TODO: post-routing handler for actual requests: Vary: Origin always; echo an allowed Origin with
  //       credentials, never "*"

  // TLS terminates at the load balancer in front of this process.
  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

const std::set<std::string> kAllowedOrigins = {"https://app.example.com", "https://admin.example.com"};
const std::set<std::string> kAllowedMethods = {"GET", "POST", "DELETE"};
const std::set<std::string> kAllowedHeaders = {"authorization", "content-type"};
constexpr const char* kAllowMethods = "GET, POST, DELETE";
constexpr int kMaxAge = 600;
constexpr const char* kPreflightVary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

std::mutex mu;
std::map<int, std::string> notes;  // id -> note JSON
int next_id = 1;

// Trimmed, lowercased, non-empty names from a comma list.
std::vector<std::string> split_names(const std::string& raw) {
  std::vector<std::string> out;
  std::stringstream in(raw);
  std::string name;
  while (std::getline(in, name, ',')) {
    const auto begin = name.find_first_not_of(" \\t");
    if (begin == std::string::npos) continue;
    name = name.substr(begin, name.find_last_not_of(" \\t") - begin + 1);
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return std::tolower(c); });
    out.push_back(name);
  }
  return out;
}

int main() {
  httplib::Server svr;

  svr.Get("/api/notes", [](const httplib::Request&, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    std::string body = "[";
    for (const auto& [id, note] : notes) body += (body.size() > 1 ? "," : "") + note;
    res.set_content(body + "]", "application/json");
  });

  svr.Post("/api/notes", [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    const int id = next_id++;
    const auto body = nlohmann::json::parse(req.body, nullptr, false);
    const std::string text = body.is_object() && body.contains("text") && body["text"].is_string() ? body["text"].get<std::string>() : "";
    notes[id] = nlohmann::json{{"id", id}, {"text", text}}.dump();
    res.status = 201;
    res.set_content(notes[id], "application/json");
  });

  svr.Delete(R"(/api/notes/(\\d+))", [](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(mu);
    notes.erase(std::stoi(req.matches[1]));
    res.status = 204;
  });

  svr.Options(R"(/api/.*)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string origin = req.get_header_value("Origin");
    const std::string method = req.get_header_value("Access-Control-Request-Method");
    if (origin.empty() || method.empty()) {
      res.status = 404;  // not a preflight
      return;
    }
    const auto requested = split_names(req.get_header_value("Access-Control-Request-Headers"));
    res.set_header("Vary", kPreflightVary);
    bool ok = kAllowedOrigins.count(origin) > 0 && kAllowedMethods.count(method) > 0;
    for (const auto& name : requested) ok = ok && kAllowedHeaders.count(name) > 0;
    if (!ok) {
      res.status = 403;
      return;
    }
    res.set_header("Access-Control-Allow-Origin", origin);
    res.set_header("Access-Control-Allow-Methods", kAllowMethods);
    if (!requested.empty()) {
      std::string joined;
      for (const auto& name : requested) joined += (joined.empty() ? "" : ", ") + name;
      res.set_header("Access-Control-Allow-Headers", joined);
    }
    res.set_header("Access-Control-Allow-Credentials", "true");
    res.set_header("Access-Control-Max-Age", std::to_string(kMaxAge));
    res.status = 204;
  });

  // Actual requests: Vary always, the grant only for an origin found in the allowlist.
  svr.set_post_routing_handler([](const httplib::Request& req, httplib::Response& res) {
    if (req.path.rfind("/api/", 0) != 0 || req.method == "OPTIONS") return;
    res.set_header("Vary", "Origin");
    const std::string origin = req.get_header_value("Origin");
    if (kAllowedOrigins.count(origin) > 0) {
      res.set_header("Access-Control-Allow-Origin", origin);
      res.set_header("Access-Control-Allow-Credentials", "true");
    }
  });

  // TLS terminates at the load balancer in front of this process.
  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  debrief: `CORS is a declaration the server makes and the browser enforces, so the server's whole job is to answer two questions exactly. For a preflight: may this origin send this method with these headers? Answer it before routing, because the routes do not know \`OPTIONS\`, and answer no with a 403 that grants nothing. For an actual request: may this origin read the response? Echo the origin only after an exact set lookup, add \`Allow-Credentials\` because the app sends cookies, and never \`*\`, which browsers refuse alongside credentials. \`Vary: Origin\` goes on every response, granted or not, because the response differs by \`Origin\` and a shared cache that does not know that serves one origin's answer to another. The routes run for every origin: CORS limits who reads, not who writes, so state-changing endpoints still need \`SameSite\` cookies or a CSRF token. Production adds \`Access-Control-Expose-Headers\` for headers scripts must read, a per-environment allowlist from configuration, and logging of rejected preflights so a new frontend origin shows up before users report it.`,
  harness: {
    python: `APP = "https://app.example.com"
ADMIN = "https://admin.example.com"
EVIL = "https://evil.example.com"


def _granted(r):
    return sorted(k for k in r.headers.keys() if k.lower().startswith("access-control-"))


def _vary(r):
    return {t.strip().lower() for t in (r.headers.get("vary") or "").split(",") if t.strip()}


async def _preflight(c, path, origin, method, headers=None):
    h = {"Origin": origin, "Access-Control-Request-Method": method}
    if headers is not None:
        h["Access-Control-Request-Headers"] = headers
    return await c.options(path, headers=h)


async def check_preflight(ctx):
    m = ctx.load("cors")
    async with ctx.client(m.app, base_url="https://service") as c:
        for origin, path, method in ((APP, "/api/notes", "POST"), (ADMIN, "/api/notes/7", "DELETE"), (APP, "/api/notes", "GET")):
            r = await _preflight(c, path, origin, method)
            where = f"OPTIONS {path} from {origin} for {method}"
            assert r.status_code == 204, f"{where} answered {r.status_code}, expected 204 (answer the preflight in the middleware, before routing)"
            assert r.content == b"", f"{where}: a 204 carries no body, got {r.content[:60]!r}"
            assert r.headers.get("access-control-allow-origin") == origin, f"{where}: Access-Control-Allow-Origin is {r.headers.get('access-control-allow-origin')!r}, expected the origin itself"
            assert r.headers.get("access-control-allow-methods") == "GET, POST, DELETE", f"{where}: Access-Control-Allow-Methods is {r.headers.get('access-control-allow-methods')!r}, expected 'GET, POST, DELETE'"
            assert r.headers.get("access-control-allow-credentials") == "true", f"{where}: Access-Control-Allow-Credentials is {r.headers.get('access-control-allow-credentials')!r}, expected 'true'"
            assert r.headers.get("access-control-max-age") == "600", f"{where}: Access-Control-Max-Age is {r.headers.get('access-control-max-age')!r}, expected '600'"
            assert "access-control-allow-headers" not in r.headers, f"{where}: no headers were requested, so Access-Control-Allow-Headers must be omitted (got {r.headers.get('access-control-allow-headers')!r})"


async def check_allow_headers(ctx):
    m = ctx.load("cors")
    async with ctx.client(m.app, base_url="https://service") as c:
        for sent, expected in (
            ("Content-Type, Authorization", "content-type, authorization"),
            (" authorization ,CONTENT-TYPE", "authorization, content-type"),
            ("content-type", "content-type"),
        ):
            r = await _preflight(c, "/api/notes", APP, "POST", sent)
            assert r.status_code == 204, f"Access-Control-Request-Headers {sent!r} names only allowed headers, but the preflight answered {r.status_code}"
            got = r.headers.get("access-control-allow-headers")
            assert got == expected, f"Access-Control-Request-Headers {sent!r}: Access-Control-Allow-Headers is {got!r}, expected {expected!r} (trimmed, lowercased, in the order sent)"
        for sent in ("Content-Type, X-Debug", "x-api-key"):
            r = await _preflight(c, "/api/notes", APP, "POST", sent)
            assert r.status_code == 403, f"Access-Control-Request-Headers {sent!r} names a header outside ALLOWED_HEADERS, but the preflight answered {r.status_code}, not 403"
            assert _granted(r) == [], f"the rejected preflight for {sent!r} still sent {_granted(r)}"


async def check_rejected(ctx):
    m = ctx.load("cors")
    async with ctx.client(m.app, base_url="https://service") as c:
        cases = (
            (EVIL, "POST", "an origin outside the allowlist"),
            ("https://app.example.com.evil.net", "GET", "a look-alike with the allowed origin as a prefix"),
            ("http://app.example.com", "GET", "the allowed host over http (a different origin)"),
            ("null", "GET", "the opaque origin 'null'"),
            (APP, "PUT", "a method outside GET, POST, DELETE"),
            (APP, "PATCH", "a method outside GET, POST, DELETE"),
        )
        for origin, method, why in cases:
            r = await _preflight(c, "/api/notes", origin, method)
            assert r.status_code == 403, f"preflight from {origin} for {method} ({why}) answered {r.status_code}, expected 403"
            assert _granted(r) == [], f"preflight from {origin} for {method} ({why}) was refused but still sent {_granted(r)}: a refusal grants nothing"


async def check_echo_origin(ctx):
    m = ctx.load("cors")
    async with ctx.client(m.app, base_url="https://service") as c:
        created = await c.post("/api/notes", json={"text": "hi"}, headers={"Origin": ADMIN, "Authorization": "Bearer t"})
        listed = await c.get("/api/notes", headers={"Origin": APP})
        deleted = await c.delete("/api/notes/1", headers={"Origin": APP})
    for name, r, status, origin in (("POST /api/notes", created, 201, ADMIN), ("GET /api/notes", listed, 200, APP), ("DELETE /api/notes/1", deleted, 204, APP)):
        assert r.status_code == status, f"{name} from {origin} answered {r.status_code}, expected {status}"
        acao = r.headers.get("access-control-allow-origin")
        assert acao != "*", f"{name}: Access-Control-Allow-Origin is '*', which browsers refuse with credentials: echo the origin"
        assert acao == origin, f"{name} from {origin}: Access-Control-Allow-Origin is {acao!r}, expected {origin!r}"
        assert r.headers.get("access-control-allow-credentials") == "true", f"{name} from {origin}: Access-Control-Allow-Credentials is {r.headers.get('access-control-allow-credentials')!r}, expected 'true'"
    assert listed.json() == [{"id": 1, "text": "hi"}], f"GET /api/notes body is {listed.text!r}: CORS must not change the response"


async def check_vary(ctx):
    m = ctx.load("cors")
    async with ctx.client(m.app, base_url="https://service") as c:
        pre = await _preflight(c, "/api/notes", APP, "POST", "content-type")
        actual = (
            ("GET from an allowed origin", await c.get("/api/notes", headers={"Origin": APP})),
            ("GET from a disallowed origin", await c.get("/api/notes", headers={"Origin": EVIL})),
            ("GET without Origin", await c.get("/api/notes")),
            ("DELETE without Origin", await c.delete("/api/notes/3")),
        )
    want = {"origin", "access-control-request-method", "access-control-request-headers"}
    assert want <= _vary(pre), f"the allowed preflight has Vary {pre.headers.get('vary')!r}, expected 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'"
    for name, r in actual:
        assert "origin" in _vary(r), f"{name} has Vary {r.headers.get('vary')!r}: every /api response depends on Origin, so a cache must key on it even when no Origin was sent"


async def check_no_origin(ctx):
    m = ctx.load("cors")
    async with ctx.client(m.app, base_url="https://service") as c:
        control = await c.get("/api/notes", headers={"Origin": APP})
        assert control.headers.get("access-control-allow-origin") == APP, f"control: GET /api/notes from {APP} must be granted, Access-Control-Allow-Origin was {control.headers.get('access-control-allow-origin')!r}"
        created = await c.post("/api/notes", json={"text": "from evil"}, headers={"Origin": EVIL})
        cases = (
            ("POST from a disallowed origin", created, 201),
            ("GET without Origin", await c.get("/api/notes"), 200),
            ("GET from a disallowed origin", await c.get("/api/notes", headers={"Origin": EVIL}), 200),
            ("GET from a look-alike origin", await c.get("/api/notes", headers={"Origin": "https://app.example.com.evil.net"}), 200),
            ("DELETE from http://app.example.com", await c.delete("/api/notes/9", headers={"Origin": "http://app.example.com"}), 204),
        )
    for name, r, status in cases:
        assert r.status_code == status, f"{name} answered {r.status_code}, expected {status}: the server answers normally, the browser enforces CORS"
        assert "access-control-allow-origin" not in r.headers, f"{name} got Access-Control-Allow-Origin {r.headers.get('access-control-allow-origin')!r}: only an origin in ALLOWED_ORIGINS is granted"
        assert "access-control-allow-credentials" not in r.headers, f"{name} got Access-Control-Allow-Credentials: grant nothing to an origin outside the allowlist"
    assert cases[1][1].json() == [{"id": 1, "text": "from evil"}], f"GET without Origin returned {cases[1][1].text!r}: the body is the same for every caller"
`,
    typescript: `const APP = 'https://app.example.com';
const ADMIN = 'https://admin.example.com';
const EVIL = 'https://evil.example.com';

const granted = r => Object.keys(r.headers).filter(k => k.toLowerCase().startsWith('access-control-')).sort();
const vary = r =>
  new Set(
    String(r.headers['vary'] ?? '')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => t !== ''),
  );
const show = (v: unknown): string => JSON.stringify(v ?? null);

async function preflight(c, path: string, origin: string, method: string, headers?: string) {
  const h: Record<string, string> = {Origin: origin, 'Access-Control-Request-Method': method};
  if (headers !== undefined) h['Access-Control-Request-Headers'] = headers;
  return c.request('OPTIONS', path, {headers: h});
}

export async function check_preflight(ctx) {
  const m = ctx.load('cors');
  const c = ctx.client(m.app);
  for (const [origin, path, method] of [
    [APP, '/api/notes', 'POST'],
    [ADMIN, '/api/notes/7', 'DELETE'],
    [APP, '/api/notes', 'GET'],
  ]) {
    const r = await preflight(c, path, origin, method);
    const where = 'OPTIONS ' + path + ' from ' + origin + ' for ' + method;
    assert.equal(r.status, 204, where + ' answered ' + r.status + ", expected 204 (answer it in an options('/api/*') route)");
    assert.equal(r.text, '', where + ': a 204 carries no body, got ' + show(r.text));
    assert.equal(r.headers['access-control-allow-origin'], origin, where + ': Access-Control-Allow-Origin is ' + show(r.headers['access-control-allow-origin']) + ', expected the origin itself');
    assert.equal(r.headers['access-control-allow-methods'], 'GET, POST, DELETE', where + ': Access-Control-Allow-Methods is ' + show(r.headers['access-control-allow-methods']) + ", expected 'GET, POST, DELETE'");
    assert.equal(r.headers['access-control-allow-credentials'], 'true', where + ': Access-Control-Allow-Credentials is ' + show(r.headers['access-control-allow-credentials']) + ", expected 'true'");
    assert.equal(r.headers['access-control-max-age'], '600', where + ': Access-Control-Max-Age is ' + show(r.headers['access-control-max-age']) + ", expected '600'");
    assert(!('access-control-allow-headers' in r.headers), where + ': no headers were requested, so Access-Control-Allow-Headers must be omitted (got ' + show(r.headers['access-control-allow-headers']) + ')');
  }
}

export async function check_allow_headers(ctx) {
  const m = ctx.load('cors');
  const c = ctx.client(m.app);
  for (const [sent, expected] of [
    ['Content-Type, Authorization', 'content-type, authorization'],
    [' authorization ,CONTENT-TYPE', 'authorization, content-type'],
    ['content-type', 'content-type'],
  ]) {
    const r = await preflight(c, '/api/notes', APP, 'POST', sent);
    assert.equal(r.status, 204, 'Access-Control-Request-Headers ' + show(sent) + ' names only allowed headers, but the preflight answered ' + r.status);
    assert.equal(r.headers['access-control-allow-headers'], expected, 'Access-Control-Request-Headers ' + show(sent) + ': Access-Control-Allow-Headers is ' + show(r.headers['access-control-allow-headers']) + ', expected ' + show(expected) + ' (trimmed, lowercased, in the order sent)');
  }
  for (const sent of ['Content-Type, X-Debug', 'x-api-key']) {
    const r = await preflight(c, '/api/notes', APP, 'POST', sent);
    assert.equal(r.status, 403, 'Access-Control-Request-Headers ' + show(sent) + ' names a header outside ALLOWED_HEADERS, but the preflight answered ' + r.status + ', not 403');
    assert.deepEqual(granted(r), [], 'the rejected preflight for ' + show(sent) + ' still sent ' + show(granted(r)));
  }
}

export async function check_rejected(ctx) {
  const m = ctx.load('cors');
  const c = ctx.client(m.app);
  const cases = [
    [EVIL, 'POST', 'an origin outside the allowlist'],
    ['https://app.example.com.evil.net', 'GET', 'a look-alike with the allowed origin as a prefix'],
    ['http://app.example.com', 'GET', 'the allowed host over http (a different origin)'],
    ['null', 'GET', "the opaque origin 'null'"],
    [APP, 'PUT', 'a method outside GET, POST, DELETE'],
    [APP, 'PATCH', 'a method outside GET, POST, DELETE'],
  ];
  for (const [origin, method, why] of cases) {
    const r = await preflight(c, '/api/notes', origin, method);
    const where = 'preflight from ' + origin + ' for ' + method + ' (' + why + ')';
    assert.equal(r.status, 403, where + ' answered ' + r.status + ', expected 403');
    assert.deepEqual(granted(r), [], where + ' was refused but still sent ' + show(granted(r)) + ': a refusal grants nothing');
  }
}

export async function check_echo_origin(ctx) {
  const m = ctx.load('cors');
  const c = ctx.client(m.app);
  const created = await c.post('/api/notes', {json: {text: 'hi'}, headers: {Origin: ADMIN, Authorization: 'Bearer t'}});
  const listed = await c.get('/api/notes', {headers: {Origin: APP}});
  const deleted = await c.delete('/api/notes/1', {headers: {Origin: APP}});
  for (const [name, r, status, origin] of [
    ['POST /api/notes', created, 201, ADMIN],
    ['GET /api/notes', listed, 200, APP],
    ['DELETE /api/notes/1', deleted, 204, APP],
  ] as const) {
    assert.equal(r.status, status, name + ' from ' + origin + ' answered ' + r.status + ', expected ' + status);
    const acao = r.headers['access-control-allow-origin'];
    assert.notEqual(acao, '*', name + ": Access-Control-Allow-Origin is '*', which browsers refuse with credentials: echo the origin");
    assert.equal(acao, origin, name + ' from ' + origin + ': Access-Control-Allow-Origin is ' + show(acao) + ', expected ' + show(origin));
    assert.equal(r.headers['access-control-allow-credentials'], 'true', name + ' from ' + origin + ': Access-Control-Allow-Credentials is ' + show(r.headers['access-control-allow-credentials']) + ", expected 'true'");
  }
  assert.deepEqual(listed.json(), [{id: 1, text: 'hi'}], 'GET /api/notes body is ' + show(listed.text) + ': CORS must not change the response');
}

export async function check_vary(ctx) {
  const m = ctx.load('cors');
  const c = ctx.client(m.app);
  const pre = await preflight(c, '/api/notes', APP, 'POST', 'content-type');
  const actual = [
    ['GET from an allowed origin', await c.get('/api/notes', {headers: {Origin: APP}})],
    ['GET from a disallowed origin', await c.get('/api/notes', {headers: {Origin: EVIL}})],
    ['GET without Origin', await c.get('/api/notes')],
    ['DELETE without Origin', await c.delete('/api/notes/3')],
  ] as const;
  const tokens = vary(pre);
  for (const want of ['origin', 'access-control-request-method', 'access-control-request-headers'])
    assert(tokens.has(want), 'the allowed preflight has Vary ' + show(pre.headers['vary']) + ", expected 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'");
  for (const [name, r] of actual)
    assert(vary(r).has('origin'), name + ' has Vary ' + show(r.headers['vary']) + ': every /api response depends on Origin, so a cache must key on it even when no Origin was sent');
}

export async function check_no_origin(ctx) {
  const m = ctx.load('cors');
  const c = ctx.client(m.app);
  const control = await c.get('/api/notes', {headers: {Origin: APP}});
  assert.equal(control.headers['access-control-allow-origin'], APP, 'control: GET /api/notes from ' + APP + ' must be granted, Access-Control-Allow-Origin was ' + show(control.headers['access-control-allow-origin']));
  const created = await c.post('/api/notes', {json: {text: 'from evil'}, headers: {Origin: EVIL}});
  const bare = await c.get('/api/notes');
  const cases = [
    ['POST from a disallowed origin', created, 201],
    ['GET without Origin', bare, 200],
    ['GET from a disallowed origin', await c.get('/api/notes', {headers: {Origin: EVIL}}), 200],
    ['GET from a look-alike origin', await c.get('/api/notes', {headers: {Origin: 'https://app.example.com.evil.net'}}), 200],
    ['DELETE from http://app.example.com', await c.delete('/api/notes/9', {headers: {Origin: 'http://app.example.com'}}), 204],
  ] as const;
  for (const [name, r, status] of cases) {
    assert.equal(r.status, status, name + ' answered ' + r.status + ', expected ' + status + ': the server answers normally, the browser enforces CORS');
    assert(!('access-control-allow-origin' in r.headers), name + ' got Access-Control-Allow-Origin ' + show(r.headers['access-control-allow-origin']) + ': only an origin in ALLOWED_ORIGINS is granted');
    assert(!('access-control-allow-credentials' in r.headers), name + ' got Access-Control-Allow-Credentials: grant nothing to an origin outside the allowlist');
  }
  assert.deepEqual(bare.json(), [{id: 1, text: 'from evil'}], 'GET without Origin returned ' + show(bare.text) + ': the body is the same for every caller');
}
`,
    go: `package main

import (
	"net/http"
	"sort"
	"strings"

	"leetbuild/harness"
)

const (
	corsApp   = "https://app.example.com"
	corsAdmin = "https://admin.example.com"
	corsEvil  = "https://evil.example.com"
)

// corsGranted lists the Access-Control-* headers a response carries, lowercased and sorted.
func corsGranted(r *harness.Response) []string {
	var names []string
	for name := range r.Header {
		if lower := strings.ToLower(name); strings.HasPrefix(lower, "access-control-") {
			names = append(names, lower)
		}
	}
	sort.Strings(names)
	return names
}

// corsVary is the set of Vary tokens, lowercased.
func corsVary(r *harness.Response) map[string]bool {
	tokens := map[string]bool{}
	for _, t := range strings.Split(strings.Join(r.Header.Values("Vary"), ","), ",") {
		if t = strings.ToLower(strings.TrimSpace(t)); t != "" {
			tokens[t] = true
		}
	}
	return tokens
}

// corsHas reports whether the response carries the header at all.
func corsHas(r *harness.Response, name string) bool {
	_, ok := r.Header[http.CanonicalHeaderKey(name)]
	return ok
}

// corsShow quotes a header's value, or says nil when it is absent.
func corsShow(r *harness.Response, name string) string {
	if !corsHas(r, name) {
		return "nil"
	}
	return harness.Show(r.Header.Get(name))
}

func corsPreflight(c *harness.HTTP, path, origin, method string, headers ...string) *harness.Response {
	h := []string{"Origin", origin, "Access-Control-Request-Method", method}
	if len(headers) > 0 {
		h = append(h, "Access-Control-Request-Headers", headers[0])
	}
	return c.Options(path, h...)
}

func CheckPreflight(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	for _, tc := range [][3]string{
		{corsApp, "/api/notes", "POST"},
		{corsAdmin, "/api/notes/7", "DELETE"},
		{corsApp, "/api/notes", "GET"},
	} {
		origin, path, method := tc[0], tc[1], tc[2]
		r := corsPreflight(c, path, origin, method)
		where := "OPTIONS " + path + " from " + origin + " for " + method
		ctx.Equal(r.Status, 204, "%s: the status (answer the preflight in cors, before routing)", where)
		ctx.Equal(r.Text(), "", "%s: a 204 carries no body", where)
		ctx.Equal(r.Header.Get("Access-Control-Allow-Origin"), origin, "%s: Access-Control-Allow-Origin must be the origin itself", where)
		ctx.Equal(r.Header.Get("Access-Control-Allow-Methods"), "GET, POST, DELETE", "%s: Access-Control-Allow-Methods", where)
		ctx.Equal(r.Header.Get("Access-Control-Allow-Credentials"), "true", "%s: Access-Control-Allow-Credentials", where)
		ctx.Equal(r.Header.Get("Access-Control-Max-Age"), "600", "%s: Access-Control-Max-Age", where)
		ctx.Assert(!corsHas(r, "Access-Control-Allow-Headers"), "%s: no headers were requested, so Access-Control-Allow-Headers must be omitted (got %s)", where, corsShow(r, "Access-Control-Allow-Headers"))
	}
}

func CheckAllowHeaders(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	for _, tc := range [][2]string{
		{"Content-Type, Authorization", "content-type, authorization"},
		{" authorization ,CONTENT-TYPE", "authorization, content-type"},
		{"content-type", "content-type"},
	} {
		sent, expected := tc[0], tc[1]
		r := corsPreflight(c, "/api/notes", corsApp, "POST", sent)
		ctx.Equal(r.Status, 204, "Access-Control-Request-Headers %q names only allowed headers, so the preflight's status", sent)
		ctx.Equal(r.Header.Get("Access-Control-Allow-Headers"), expected, "Access-Control-Request-Headers %q: Access-Control-Allow-Headers (trimmed, lowercased, in the order sent)", sent)
	}
	for _, sent := range []string{"Content-Type, X-Debug", "x-api-key"} {
		r := corsPreflight(c, "/api/notes", corsApp, "POST", sent)
		ctx.Equal(r.Status, 403, "Access-Control-Request-Headers %q names a header outside allowedHeaders, so the preflight's status", sent)
		ctx.Equal(corsGranted(r), []string(nil), "the rejected preflight for %q still sent Access-Control-* headers", sent)
	}
}

func CheckRejected(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	for _, tc := range [][3]string{
		{corsEvil, "POST", "an origin outside the allowlist"},
		{"https://app.example.com.evil.net", "GET", "a look-alike with the allowed origin as a prefix"},
		{"http://app.example.com", "GET", "the allowed host over http (a different origin)"},
		{"null", "GET", "the opaque origin 'null'"},
		{corsApp, "PUT", "a method outside GET, POST, DELETE"},
		{corsApp, "PATCH", "a method outside GET, POST, DELETE"},
	} {
		origin, method, why := tc[0], tc[1], tc[2]
		r := corsPreflight(c, "/api/notes", origin, method)
		where := "preflight from " + origin + " for " + method + " (" + why + ")"
		ctx.Equal(r.Status, 403, "%s: the status", where)
		ctx.Equal(corsGranted(r), []string(nil), "%s was refused but still sent Access-Control-* headers: a refusal grants nothing", where)
	}
}

func CheckEchoOrigin(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	created := c.Post("/api/notes", map[string]any{"text": "hi"}, "Origin", corsAdmin, "Authorization", "Bearer t")
	listed := c.Get("/api/notes", "Origin", corsApp)
	deleted := c.Delete("/api/notes/1", "Origin", corsApp)
	for _, tc := range []struct {
		name   string
		r      *harness.Response
		status int
		origin string
	}{
		{"POST /api/notes", created, 201, corsAdmin},
		{"GET /api/notes", listed, 200, corsApp},
		{"DELETE /api/notes/1", deleted, 204, corsApp},
	} {
		ctx.Equal(tc.r.Status, tc.status, "%s from %s: the status", tc.name, tc.origin)
		acao := tc.r.Header.Get("Access-Control-Allow-Origin")
		ctx.Assert(acao != "*", "%s: Access-Control-Allow-Origin is '*', which browsers refuse with credentials: echo the origin", tc.name)
		ctx.Equal(acao, tc.origin, "%s from %s: Access-Control-Allow-Origin", tc.name, tc.origin)
		ctx.Equal(tc.r.Header.Get("Access-Control-Allow-Credentials"), "true", "%s from %s: Access-Control-Allow-Credentials", tc.name, tc.origin)
	}
	ctx.Equal(listed.JSON(), []any{map[string]any{"id": float64(1), "text": "hi"}}, "GET /api/notes body: CORS must not change the response")
}

func CheckVary(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	pre := corsPreflight(c, "/api/notes", corsApp, "POST", "content-type")
	actual := []struct {
		name string
		r    *harness.Response
	}{
		{"GET from an allowed origin", c.Get("/api/notes", "Origin", corsApp)},
		{"GET from a disallowed origin", c.Get("/api/notes", "Origin", corsEvil)},
		{"GET without Origin", c.Get("/api/notes")},
		{"DELETE without Origin", c.Delete("/api/notes/3")},
	}
	tokens := corsVary(pre)
	for _, want := range []string{"origin", "access-control-request-method", "access-control-request-headers"} {
		ctx.Assert(tokens[want], "the allowed preflight has Vary %s, expected 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'", corsShow(pre, "Vary"))
	}
	for _, a := range actual {
		ctx.Assert(corsVary(a.r)["origin"], "%s has Vary %s: every /api response depends on Origin, so a cache must key on it even when no Origin was sent", a.name, corsShow(a.r, "Vary"))
	}
}

func CheckNoOrigin(ctx *harness.Ctx) {
	c := ctx.Main(main).HTTP()
	control := c.Get("/api/notes", "Origin", corsApp)
	ctx.Equal(control.Header.Get("Access-Control-Allow-Origin"), corsApp, "control: GET /api/notes from %s must be granted, Access-Control-Allow-Origin", corsApp)
	created := c.Post("/api/notes", map[string]any{"text": "from evil"}, "Origin", corsEvil)
	bare := c.Get("/api/notes")
	cases := []struct {
		name   string
		r      *harness.Response
		status int
	}{
		{"POST from a disallowed origin", created, 201},
		{"GET without Origin", bare, 200},
		{"GET from a disallowed origin", c.Get("/api/notes", "Origin", corsEvil), 200},
		{"GET from a look-alike origin", c.Get("/api/notes", "Origin", "https://app.example.com.evil.net"), 200},
		{"DELETE from http://app.example.com", c.Delete("/api/notes/9", "Origin", "http://app.example.com"), 204},
	}
	for _, tc := range cases {
		ctx.Equal(tc.r.Status, tc.status, "%s: the status (the server answers normally, the browser enforces CORS)", tc.name)
		ctx.Assert(!corsHas(tc.r, "Access-Control-Allow-Origin"), "%s got Access-Control-Allow-Origin %s: only an origin in allowedOrigins is granted", tc.name, corsShow(tc.r, "Access-Control-Allow-Origin"))
		ctx.Assert(!corsHas(tc.r, "Access-Control-Allow-Credentials"), "%s got Access-Control-Allow-Credentials: grant nothing to an origin outside the allowlist", tc.name)
	}
	ctx.Equal(bare.JSON(), []any{map[string]any{"id": float64(1), "text": "from evil"}}, "GET without Origin: the body is the same for every caller")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cctype>
#include <set>
#include <string>
#include <vector>

namespace {

const std::string corsApp = "https://app.example.com";
const std::string corsAdmin = "https://admin.example.com";
const std::string corsEvil = "https://evil.example.com";

std::string corsLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
  return s;
}

// corsGranted lists the Access-Control-* headers a response carries, lowercased and sorted.
std::vector<std::string> corsGranted(const harness::Response& r) {
  std::set<std::string> names;
  for (const auto& [name, value] : r.Header) {
    const std::string lower = corsLower(name);
    if (lower.rfind("access-control-", 0) == 0) names.insert(lower);
  }
  return {names.begin(), names.end()};
}

// corsVary is the set of Vary tokens, lowercased.
std::set<std::string> corsVary(const harness::Response& r) {
  std::set<std::string> tokens;
  const auto [begin, end] = r.Header.equal_range("Vary");
  for (auto it = begin; it != end; ++it) {
    const std::string& v = it->second;
    size_t start = 0;
    while (start <= v.size()) {
      size_t comma = v.find(',', start);
      if (comma == std::string::npos) comma = v.size();
      std::string t = v.substr(start, comma - start);
      const auto b = t.find_first_not_of(" \\t");
      if (b != std::string::npos) tokens.insert(corsLower(t.substr(b, t.find_last_not_of(" \\t") - b + 1)));
      start = comma + 1;
    }
  }
  return tokens;
}

// corsHas reports whether the response carries the header at all.
bool corsHas(const harness::Response& r, const std::string& name) { return r.Header.count(name) > 0; }

// corsShow quotes a header's value, or says nil when it is absent.
std::string corsShow(const harness::Response& r, const std::string& name) {
  if (!corsHas(r, name)) return "nil";
  return harness::Value(r.HeaderValue(name), true);
}

harness::Response corsPreflight(harness::HTTP& c, const std::string& path, const std::string& origin,
                                const std::string& method, const std::string* headers = nullptr) {
  std::vector<std::string> h = {"Origin", origin, "Access-Control-Request-Method", method};
  if (headers) {
    h.push_back("Access-Control-Request-Headers");
    h.push_back(*headers);
  }
  return c.Send("OPTIONS", path, "", h);
}

}  // namespace

void CheckPreflight(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const std::vector<std::vector<std::string>> cases = {
      {corsApp, "/api/notes", "POST"},
      {corsAdmin, "/api/notes/7", "DELETE"},
      {corsApp, "/api/notes", "GET"},
  };
  for (const auto& tc : cases) {
    const std::string &origin = tc[0], &path = tc[1], &method = tc[2];
    const auto r = corsPreflight(c, path, origin, method);
    const std::string where = "OPTIONS " + path + " from " + origin + " for " + method;
    ctx.Equal(r.Status, 204, "%s: the status (answer the preflight in cors, before routing)", where);
    ctx.Equal(r.Text(), "", "%s: a 204 carries no body", where);
    ctx.Equal(r.HeaderValue("Access-Control-Allow-Origin"), origin, "%s: Access-Control-Allow-Origin must be the origin itself", where);
    ctx.Equal(r.HeaderValue("Access-Control-Allow-Methods"), "GET, POST, DELETE", "%s: Access-Control-Allow-Methods", where);
    ctx.Equal(r.HeaderValue("Access-Control-Allow-Credentials"), "true", "%s: Access-Control-Allow-Credentials", where);
    ctx.Equal(r.HeaderValue("Access-Control-Max-Age"), "600", "%s: Access-Control-Max-Age", where);
    ctx.Assert(!corsHas(r, "Access-Control-Allow-Headers"), "%s: no headers were requested, so Access-Control-Allow-Headers must be omitted (got %s)", where, corsShow(r, "Access-Control-Allow-Headers"));
  }
}

void CheckAllowHeaders(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const std::vector<std::vector<std::string>> cases = {
      {"Content-Type, Authorization", "content-type, authorization"},
      {" authorization ,CONTENT-TYPE", "authorization, content-type"},
      {"content-type", "content-type"},
  };
  for (const auto& tc : cases) {
    const std::string &sent = tc[0], &expected = tc[1];
    const auto r = corsPreflight(c, "/api/notes", corsApp, "POST", &sent);
    ctx.Equal(r.Status, 204, "Access-Control-Request-Headers %q names only allowed headers, so the preflight's status", sent);
    ctx.Equal(r.HeaderValue("Access-Control-Allow-Headers"), expected, "Access-Control-Request-Headers %q: Access-Control-Allow-Headers (trimmed, lowercased, in the order sent)", sent);
  }
  for (const std::string sent : {"Content-Type, X-Debug", "x-api-key"}) {
    const auto r = corsPreflight(c, "/api/notes", corsApp, "POST", &sent);
    ctx.Equal(r.Status, 403, "Access-Control-Request-Headers %q names a header outside allowedHeaders, so the preflight's status", sent);
    ctx.Equal(corsGranted(r), std::vector<std::string>{}, "the rejected preflight for %q still sent Access-Control-* headers", sent);
  }
}

void CheckRejected(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const std::vector<std::vector<std::string>> cases = {
      {corsEvil, "POST", "an origin outside the allowlist"},
      {"https://app.example.com.evil.net", "GET", "a look-alike with the allowed origin as a prefix"},
      {"http://app.example.com", "GET", "the allowed host over http (a different origin)"},
      {"null", "GET", "the opaque origin 'null'"},
      {corsApp, "PUT", "a method outside GET, POST, DELETE"},
      {corsApp, "PATCH", "a method outside GET, POST, DELETE"},
  };
  for (const auto& tc : cases) {
    const std::string &origin = tc[0], &method = tc[1], &why = tc[2];
    const auto r = corsPreflight(c, "/api/notes", origin, method);
    const std::string where = "preflight from " + origin + " for " + method + " (" + why + ")";
    ctx.Equal(r.Status, 403, "%s: the status", where);
    ctx.Equal(corsGranted(r), std::vector<std::string>{}, "%s was refused but still sent Access-Control-* headers: a refusal grants nothing", where);
  }
}

void CheckEchoOrigin(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const auto created = c.Post("/api/notes", R"({"text":"hi"})", "Origin", corsAdmin, "Authorization", "Bearer t");
  const auto listed = c.Get("/api/notes", "Origin", corsApp);
  const auto deleted = c.Delete("/api/notes/1", "Origin", corsApp);
  struct Case {
    std::string name;
    const harness::Response& r;
    int status;
    std::string origin;
  };
  const std::vector<Case> cases = {
      {"POST /api/notes", created, 201, corsAdmin},
      {"GET /api/notes", listed, 200, corsApp},
      {"DELETE /api/notes/1", deleted, 204, corsApp},
  };
  for (const auto& tc : cases) {
    ctx.Equal(tc.r.Status, tc.status, "%s from %s: the status", tc.name, tc.origin);
    const std::string acao = tc.r.HeaderValue("Access-Control-Allow-Origin");
    ctx.Assert(acao != "*", "%s: Access-Control-Allow-Origin is '*', which browsers refuse with credentials: echo the origin", tc.name);
    ctx.Equal(acao, tc.origin, "%s from %s: Access-Control-Allow-Origin", tc.name, tc.origin);
    ctx.Equal(tc.r.HeaderValue("Access-Control-Allow-Credentials"), "true", "%s from %s: Access-Control-Allow-Credentials", tc.name, tc.origin);
  }
  ctx.Equal(listed.JSON(), harness::ParseJSON(R"([{"id":1,"text":"hi"}])"), "GET /api/notes body: CORS must not change the response");
}

void CheckVary(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const std::string contentType = "content-type";
  const auto pre = corsPreflight(c, "/api/notes", corsApp, "POST", &contentType);
  struct Actual {
    std::string name;
    harness::Response r;
  };
  std::vector<Actual> actual;
  actual.push_back({"GET from an allowed origin", c.Get("/api/notes", "Origin", corsApp)});
  actual.push_back({"GET from a disallowed origin", c.Get("/api/notes", "Origin", corsEvil)});
  actual.push_back({"GET without Origin", c.Get("/api/notes")});
  actual.push_back({"DELETE without Origin", c.Delete("/api/notes/3")});
  const auto tokens = corsVary(pre);
  for (const std::string want : {"origin", "access-control-request-method", "access-control-request-headers"}) {
    ctx.Assert(tokens.count(want) > 0, "the allowed preflight has Vary %s, expected 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'", corsShow(pre, "Vary"));
  }
  for (const auto& a : actual) {
    ctx.Assert(corsVary(a.r).count("origin") > 0, "%s has Vary %s: every /api response depends on Origin, so a cache must key on it even when no Origin was sent", a.name, corsShow(a.r, "Vary"));
  }
}

void CheckNoOrigin(harness::Ctx& ctx) {
  auto c = ctx.Main().HTTP();
  const auto control = c.Get("/api/notes", "Origin", corsApp);
  ctx.Equal(control.HeaderValue("Access-Control-Allow-Origin"), corsApp, "control: GET /api/notes from %s must be granted, Access-Control-Allow-Origin", corsApp);
  const auto created = c.Post("/api/notes", R"({"text":"from evil"})", "Origin", corsEvil);
  const auto bare = c.Get("/api/notes");
  struct Case {
    std::string name;
    harness::Response r;
    int status;
  };
  std::vector<Case> cases;
  cases.push_back({"POST from a disallowed origin", created, 201});
  cases.push_back({"GET without Origin", bare, 200});
  cases.push_back({"GET from a disallowed origin", c.Get("/api/notes", "Origin", corsEvil), 200});
  cases.push_back({"GET from a look-alike origin", c.Get("/api/notes", "Origin", "https://app.example.com.evil.net"), 200});
  cases.push_back({"DELETE from http://app.example.com", c.Delete("/api/notes/9", "Origin", "http://app.example.com"), 204});
  for (const auto& tc : cases) {
    ctx.Equal(tc.r.Status, tc.status, "%s: the status (the server answers normally, the browser enforces CORS)", tc.name);
    ctx.Assert(!corsHas(tc.r, "Access-Control-Allow-Origin"), "%s got Access-Control-Allow-Origin %s: only an origin in allowedOrigins is granted", tc.name, corsShow(tc.r, "Access-Control-Allow-Origin"));
    ctx.Assert(!corsHas(tc.r, "Access-Control-Allow-Credentials"), "%s got Access-Control-Allow-Credentials: grant nothing to an origin outside the allowlist", tc.name);
  }
  ctx.Equal(bare.JSON(), harness::ParseJSON(R"([{"id":1,"text":"from evil"}])"), "GET without Origin: the body is the same for every caller");
}
`,
  },
};
