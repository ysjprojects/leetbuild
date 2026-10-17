import type {Step} from '@/lib/types';

export const counterApiStep: Step = {
  id: 'counter-api',
  title: 'One counter API over two kinds of counter',
  concept: 'http',
  file: 'counter_api',
  focus: ['client', 'api'],
  task: `## Task

Counters live in **namespaces**, and a namespace is configured once as \`best_effort\` or
\`eventually_consistent\` — the caller never chooses per request. \`NAMESPACES\` is provided
(\`views\` is best-effort, \`plays\` is eventually consistent), and so are stubs of the functions the
later steps build: \`add_best_effort\` / \`get_best_effort\` / \`clear_best_effort\` (step 2),
\`append_event\` (step 3), \`get_rolled_up\` / \`clear_rolled_up\` (step 4).

Implement the three routes:

- \`POST /counters/{ns}/{name}/add\` with body \`{"delta": 1, "token": "…"}\`, \`GET /counters/{ns}/{name}\`
  and \`DELETE /counters/{ns}/{name}\`.
- An unknown namespace is a **404** on every route; a name that does not match \`NAME_RE\`
  (\`^[A-Za-z0-9_-]{1,64}$\`) is a **400**. Check the namespace first: it decides everything else.
- \`delta\` must be a non-zero integer within **±MAX_DELTA** (1 000 000), else **400**. An
  eventually-consistent add needs a non-empty \`token\` (**400** without one): it is the idempotency key
  the rollup dedupes on. Best-effort adds ignore the token — a cache cannot dedupe.
- Best-effort add → \`add_best_effort\` and **200** \`{"count": …}\`: the new value is known right away.
  Eventually-consistent add → \`append_event\` and **202** \`{"accepted": true}\`: the event is durable, the
  count is not visible yet.
- \`GET\` answers **200** \`{"count": …}\` from \`get_best_effort\` or \`get_rolled_up\`; \`DELETE\` calls the
  matching clear and answers **204**.

:::widget status-codes {}

> 200 and 202 are the API telling the truth: a best-effort counter moved, an eventually-consistent one
> *will*. A client that reads right after a 202 and sees the old count is not seeing a bug.`,
  sequence: {
    participants: ['Caller', 'counters', 'best_effort', 'count_events'],
    messages: [
      {from: 'Caller', to: 'counters', label: 'POST /counters/views/trailer-7/add {delta: 1}', kind: 'sync'},
      {from: 'counters', to: 'counters', label: 'views → best_effort · name ok · delta ok', kind: 'sync'},
      {from: 'counters', to: 'best_effort', label: 'add_best_effort(views, trailer-7, 1)', kind: 'sync'},
      {from: 'best_effort', to: 'counters', label: '1207', kind: 'reply'},
      {from: 'counters', to: 'Caller', label: '200 {count: 1207}', kind: 'reply'},
      {
        from: 'Caller',
        to: 'counters',
        label: 'POST /counters/plays/stranger-things/add {delta: 1, token: t-9f3}',
        kind: 'sync',
      },
      {from: 'counters', to: 'count_events', label: 'append_event(plays, stranger-things, 1, t-9f3)', kind: 'sync'},
      {from: 'counters', to: 'Caller', label: '202 {accepted: true}', kind: 'reply'},
    ],
  },
  hints: [
    'Write one helper that takes `(ns, name)`, raises the 404 or the 400, and returns the namespace kind; all three handlers start by calling it.',
    'The delta and token checks only exist on the add route, and the token check only in the eventually-consistent branch: a best-effort counter has nothing to dedupe with.',
    'Two branches, two status codes: `add_best_effort` returns the count you put in the 200 body; `append_event` returns nothing, and the 202 body says only that the event was accepted.',
  ],
  checks: [
    {
      id: 'routes',
      title: 'Handles add, get and clear under /counters/{ns}/{name}',
      detail:
        'Handlers must be registered for `POST /counters/{ns}/{name}/add`, `GET /counters/{ns}/{name}` and `DELETE /counters/{ns}/{name}`.',
      match: {
        python: {
          all: [
            /@app\.post\(\s*["']\/counters\/\{ns\}\/\{name\}\/add["']/,
            /@app\.get\(\s*["']\/counters\/\{ns\}\/\{name\}["']/,
            /@app\.delete\(\s*["']\/counters\/\{ns\}\/\{name\}["']/,
          ],
        },
        go: {
          all: [
            /HandleFunc\(\s*"POST \/counters\/\{ns\}\/\{name\}\/add"/,
            /HandleFunc\(\s*"GET \/counters\/\{ns\}\/\{name\}"/,
            /HandleFunc\(\s*"DELETE \/counters\/\{ns\}\/\{name\}"/,
          ],
        },
        scala: {
          all: [
            /pathPrefix\(\s*"counters"\s*\/\s*Segment\s*\/\s*Segment\s*\)/,
            /path\(\s*"add"\s*\)/,
            /\bpost\s*\{/,
            /\bget\s*\{/,
            /\bdelete\s*\{/,
          ],
        },
        cpp: {
          all: [
            /svr\.Post\(\s*R?"\(?\/counters\//,
            /svr\.Get\(\s*R?"\(?\/counters\//,
            /svr\.Delete\(\s*R?"\(?\/counters\//,
          ],
        },
      },
    },
    {
      id: 'unknown-namespace',
      title: 'Answers 404 for a namespace that is not configured',
      detail:
        'Look the namespace up in `NAMESPACES` before anything else and answer `404 Not Found` when it is missing: counters only exist inside a configured namespace.',
      match: {
        python: {all: [/NAMESPACES\.get\(|in NAMESPACES/, /status_code\s*=\s*404/]},
        go: {all: [/namespaces\[/, /http\.StatusNotFound|\b404\b/]},
        scala: {all: [/Namespaces\.get\(|Namespaces\.contains\(/, /StatusCodes\.NotFound|\b404\b/]},
        cpp: {all: [/kNamespaces\.find\(|kNamespaces\.count\(/, /(status\s*=|fail\(\s*res\s*,)\s*404/]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects a bad name, a zero or oversized delta, and a missing token with 400',
      detail:
        'The name must match `NAME_RE`, the delta must be non-zero and within `±MAX_DELTA`, and an eventually-consistent add must carry a token; each failure is a `400 Bad Request`.',
      match: {
        python: {all: [/NAME_RE\.(fullmatch|match)\(/, /MAX_DELTA/, /status_code\s*=\s*400/]},
        go: {all: [/nameRe\.MatchString\(/, /maxDelta/, /http\.StatusBadRequest|\b400\b/]},
        scala: {
          all: [
            /NameRe\.(matches|findFirstIn|unapplySeq)\(|matches\(\s*NameRe/,
            /MaxDelta/,
            /StatusCodes\.BadRequest|\b400\b/,
          ],
        },
        cpp: {all: [/std::regex_match\([^\n]*kNameRe/, /kMaxDelta/, /(status\s*=|fail\(\s*res\s*,)\s*400/]},
      },
    },
    {
      id: 'add-dispatch',
      title: 'Best-effort adds answer 200 with the count, eventually-consistent ones 202',
      detail:
        'A best-effort namespace calls `add_best_effort` and returns the new count with `200`; an eventually-consistent one calls `append_event` and answers `202 Accepted` — the count is not yet visible.',
      match: {
        python: {all: [/(?<!def )add_best_effort\(/, /(?<!def )append_event\(/, /status_code\s*=\s*202/, /"count"/]},
        go: {all: [/(?<!func )addBestEffort\(/, /(?<!func )appendEvent\(/, /http\.StatusAccepted|\b202\b/, /"count"/]},
        scala: {
          all: [/(?<!def )addBestEffort\(/, /(?<!def )appendEvent\(/, /StatusCodes\.Accepted|\b202\b/, /"count"/],
        },
        cpp: {all: [/(?<!long )add_best_effort\(/, /(?<!void )append_event\(/, /status\s*=\s*202/, /"count"/]},
      },
    },
    {
      id: 'read-clear-dispatch',
      title: 'GET and DELETE route to the right store and DELETE answers 204',
      detail:
        '`GET` reads through `get_best_effort` or `get_rolled_up` depending on the namespace; `DELETE` calls `clear_best_effort` or `clear_rolled_up` and answers `204 No Content`.',
      match: {
        python: {
          all: [
            /(?<!def )get_best_effort\(/,
            /(?<!def )get_rolled_up\(/,
            /(?<!def )clear_best_effort\(/,
            /(?<!def )clear_rolled_up\(/,
            /status_code\s*=\s*204/,
          ],
        },
        go: {
          all: [
            /(?<!func )getBestEffort\(/,
            /(?<!func )getRolledUp\(/,
            /(?<!func )clearBestEffort\(/,
            /(?<!func )clearRolledUp\(/,
            /http\.StatusNoContent|\b204\b/,
          ],
        },
        scala: {
          all: [
            /(?<!def )getBestEffort\(/,
            /(?<!def )getRolledUp\(/,
            /(?<!def )clearBestEffort\(/,
            /(?<!def )clearRolledUp\(/,
            /StatusCodes\.NoContent|\b204\b/,
          ],
        },
        cpp: {
          all: [
            /(?<!long )get_best_effort\(/,
            /(?<!long )get_rolled_up\(/,
            /(?<!void )clear_best_effort\(/,
            /(?<!void )clear_rolled_up\(/,
            /status\s*=\s*204/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import re

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

app = FastAPI()

# Namespaces and their counter type (provided): configured per use case, never chosen per request.
NAMESPACES = {
    "views": "best_effort",
    "plays": "eventually_consistent",
}
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_DELTA = 1_000_000


# Built in later steps.
def add_best_effort(ns: str, name: str, delta: int) -> int:
    """INCRBY on the cached counter; returns the new count (step 2)."""
    raise NotImplementedError


def get_best_effort(ns: str, name: str) -> int:
    raise NotImplementedError


def clear_best_effort(ns: str, name: str) -> None:
    raise NotImplementedError


def append_event(ns: str, name: str, delta: int, token: str) -> None:
    """Logs the add durably; the count moves once the rollup has run (step 3)."""
    raise NotImplementedError


def get_rolled_up(ns: str, name: str) -> int:
    raise NotImplementedError


def clear_rolled_up(ns: str, name: str) -> None:
    raise NotImplementedError


class AddRequest(BaseModel):
    delta: int = 0
    token: str = ""


@app.post("/counters/{ns}/{name}/add")
def add(ns: str, name: str, body: AddRequest) -> JSONResponse:
    # TODO: 404 unless ns is in NAMESPACES; 400 unless NAME_RE matches name
    # TODO: 400 when delta is 0 or beyond ±MAX_DELTA; eventually_consistent → 400 without a token
    # TODO: best_effort → add_best_effort → 200 {"count": …}
    # TODO: eventually_consistent → append_event → 202 {"accepted": true}
    raise HTTPException(status_code=501)


@app.get("/counters/{ns}/{name}")
def get(ns: str, name: str) -> JSONResponse:
    # TODO: same 404 / 400; best_effort → get_best_effort, else get_rolled_up → 200 {"count": …}
    raise HTTPException(status_code=501)


@app.delete("/counters/{ns}/{name}")
def clear(ns: str, name: str) -> Response:
    # TODO: same 404 / 400; clear_best_effort or clear_rolled_up → 204
    raise HTTPException(status_code=501)


# uvicorn counter_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import re

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

app = FastAPI()

# Namespaces and their counter type (provided): configured per use case, never chosen per request.
NAMESPACES = {
    "views": "best_effort",
    "plays": "eventually_consistent",
}
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_DELTA = 1_000_000


# Built in later steps.
def add_best_effort(ns: str, name: str, delta: int) -> int:
    """INCRBY on the cached counter; returns the new count (step 2)."""
    raise NotImplementedError


def get_best_effort(ns: str, name: str) -> int:
    raise NotImplementedError


def clear_best_effort(ns: str, name: str) -> None:
    raise NotImplementedError


def append_event(ns: str, name: str, delta: int, token: str) -> None:
    """Logs the add durably; the count moves once the rollup has run (step 3)."""
    raise NotImplementedError


def get_rolled_up(ns: str, name: str) -> int:
    raise NotImplementedError


def clear_rolled_up(ns: str, name: str) -> None:
    raise NotImplementedError


class AddRequest(BaseModel):
    delta: int = 0
    token: str = ""


def resolve(ns: str, name: str) -> str:
    """The namespace's counter type, or the 404 / 400 every route shares."""
    kind = NAMESPACES.get(ns)
    if kind is None:
        raise HTTPException(status_code=404, detail="unknown namespace")
    if not NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="name must match [A-Za-z0-9_-]{1,64}")
    return kind


@app.post("/counters/{ns}/{name}/add")
def add(ns: str, name: str, body: AddRequest) -> JSONResponse:
    kind = resolve(ns, name)
    if body.delta == 0 or abs(body.delta) > MAX_DELTA:
        raise HTTPException(status_code=400, detail="delta must be a non-zero integer within ±1000000")
    if kind == "best_effort":
        return JSONResponse({"count": add_best_effort(ns, name, body.delta)}, status_code=200)
    if not body.token:
        raise HTTPException(status_code=400, detail="token is required: it is what makes a retry safe")
    append_event(ns, name, body.delta, body.token)
    return JSONResponse({"accepted": True}, status_code=202)


@app.get("/counters/{ns}/{name}")
def get(ns: str, name: str) -> JSONResponse:
    kind = resolve(ns, name)
    count = get_best_effort(ns, name) if kind == "best_effort" else get_rolled_up(ns, name)
    return JSONResponse({"count": count}, status_code=200)


@app.delete("/counters/{ns}/{name}")
def clear(ns: str, name: str) -> Response:
    kind = resolve(ns, name)
    if kind == "best_effort":
        clear_best_effort(ns, name)
    else:
        clear_rolled_up(ns, name)
    return Response(status_code=204)


# uvicorn counter_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
)

const maxDelta = 1_000_000

// Namespaces and their counter type (provided): configured per use case, never chosen per request.
var namespaces = map[string]string{
	"views": "best_effort",
	"plays": "eventually_consistent",
}

var nameRe = regexp.MustCompile(\`^[A-Za-z0-9_-]{1,64}$\`)

// Built in later steps.
func addBestEffort(ns, name string, delta int64) (int64, error)    { panic("not implemented") } // step 2
func getBestEffort(ns, name string) (int64, error)                 { panic("not implemented") }
func clearBestEffort(ns, name string) error                        { panic("not implemented") }
func appendEvent(ns, name string, delta int64, token string) error { panic("not implemented") } // step 3
func getRolledUp(ns, name string) (int64, error)                   { panic("not implemented") } // step 4
func clearRolledUp(ns, name string) error                          { panic("not implemented") }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func add(rw http.ResponseWriter, r *http.Request) {
	ns, name := r.PathValue("ns"), r.PathValue("name")
	var req struct {
		Delta int64  \`json:"delta"\`
		Token string \`json:"token"\`
	}
	err := json.NewDecoder(r.Body).Decode(&req)
	// TODO: 404 unless namespaces[ns] exists; 400 unless nameRe matches name
	// TODO: 400 when err != nil, Delta is 0 or beyond ±maxDelta; eventually_consistent → 400 without a Token
	// TODO: best_effort → addBestEffort → 200 {"count": …}
	// TODO: eventually_consistent → appendEvent → 202 {"accepted": true}
	_, _, _ = ns, name, err
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func get(rw http.ResponseWriter, r *http.Request) {
	ns, name := r.PathValue("ns"), r.PathValue("name")
	// TODO: same 404 / 400; best_effort → getBestEffort, else getRolledUp → 200 {"count": …}
	_, _ = ns, name
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func clear(rw http.ResponseWriter, r *http.Request) {
	ns, name := r.PathValue("ns"), r.PathValue("name")
	// TODO: same 404 / 400; clearBestEffort or clearRolledUp → 204
	_, _ = ns, name
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /counters/{ns}/{name}/add", add)
	mux.HandleFunc("GET /counters/{ns}/{name}", get)
	mux.HandleFunc("DELETE /counters/{ns}/{name}", clear)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
)

const maxDelta = 1_000_000

// Namespaces and their counter type (provided): configured per use case, never chosen per request.
var namespaces = map[string]string{
	"views": "best_effort",
	"plays": "eventually_consistent",
}

var nameRe = regexp.MustCompile(\`^[A-Za-z0-9_-]{1,64}$\`)

// Built in later steps.
func addBestEffort(ns, name string, delta int64) (int64, error)    { panic("not implemented") } // step 2
func getBestEffort(ns, name string) (int64, error)                 { panic("not implemented") }
func clearBestEffort(ns, name string) error                        { panic("not implemented") }
func appendEvent(ns, name string, delta int64, token string) error { panic("not implemented") } // step 3
func getRolledUp(ns, name string) (int64, error)                   { panic("not implemented") } // step 4
func clearRolledUp(ns, name string) error                          { panic("not implemented") }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// resolve answers the 404 / 400 every route shares and returns the namespace's counter type; ok is false once it has answered.
func resolve(rw http.ResponseWriter, r *http.Request) (kind, ns, name string, ok bool) {
	ns, name = r.PathValue("ns"), r.PathValue("name")
	kind, found := namespaces[ns]
	if !found {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown namespace"})
		return "", ns, name, false
	}
	if !nameRe.MatchString(name) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "name must match [A-Za-z0-9_-]{1,64}"})
		return "", ns, name, false
	}
	return kind, ns, name, true
}

func add(rw http.ResponseWriter, r *http.Request) {
	kind, ns, name, ok := resolve(rw, r)
	if !ok {
		return
	}
	var req struct {
		Delta int64  \`json:"delta"\`
		Token string \`json:"token"\`
	}
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil || req.Delta == 0 || req.Delta > maxDelta || req.Delta < -maxDelta {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "delta must be a non-zero integer within ±1000000"})
		return
	}
	if kind == "best_effort" {
		count, err := addBestEffort(ns, name, req.Delta)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		writeJSON(rw, http.StatusOK, map[string]int64{"count": count})
		return
	}
	if req.Token == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "token is required: it is what makes a retry safe"})
		return
	}
	if err := appendEvent(ns, name, req.Delta, req.Token); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]bool{"accepted": true})
}

func get(rw http.ResponseWriter, r *http.Request) {
	kind, ns, name, ok := resolve(rw, r)
	if !ok {
		return
	}
	var count int64
	var err error
	if kind == "best_effort" {
		count, err = getBestEffort(ns, name)
	} else {
		count, err = getRolledUp(ns, name)
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]int64{"count": count})
}

func clear(rw http.ResponseWriter, r *http.Request) {
	kind, ns, name, ok := resolve(rw, r)
	if !ok {
		return
	}
	var err error
	if kind == "best_effort" {
		err = clearBestEffort(ns, name)
	} else {
		err = clearRolledUp(ns, name)
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	rw.WriteHeader(http.StatusNoContent)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /counters/{ns}/{name}/add", add)
	mux.HandleFunc("GET /counters/{ns}/{name}", get)
	mux.HandleFunc("DELETE /counters/{ns}/{name}", clear)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import counters.Tls // Tls.serverContext — provided
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AddRequest(delta: Option[Long], token: Option[String])

object CounterApi {
  /** Namespaces and their counter type (provided): configured per use case, never chosen per request. */
  val Namespaces = Map("views" -> "best_effort", "plays" -> "eventually_consistent")
  val NameRe = "^[A-Za-z0-9_-]{1,64}$".r
  val MaxDelta = 1000000L

  implicit val addFormat: RootJsonFormat[AddRequest] = jsonFormat2(AddRequest)

  /** Built in later steps. */
  def addBestEffort(ns: String, name: String, delta: Long): Long = ??? // step 2
  def getBestEffort(ns: String, name: String): Long = ???
  def clearBestEffort(ns: String, name: String): Unit = ???
  def appendEvent(ns: String, name: String, delta: Long, token: String): Unit = ??? // step 3
  def getRolledUp(ns: String, name: String): Long = ??? // step 4
  def clearRolledUp(ns: String, name: String): Unit = ???

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    pathPrefix("counters" / Segment / Segment) { (ns, name) =>
      // TODO: 404 unless Namespaces has ns; 400 unless NameRe matches name
      concat(
        path("add") {
          post {
            entity(as[AddRequest]) { req =>
              // TODO: 400 when delta is missing, 0 or beyond ±MaxDelta; eventually_consistent → 400 without a token
              // TODO: best_effort → addBestEffort → 200 {"count": …}
              // TODO: eventually_consistent → appendEvent → 202 {"accepted": true}
              json(StatusCodes.NotImplemented, """{"error":"not implemented"}""")
            }
          }
        },
        pathEnd {
          concat(
            get {
              // TODO: best_effort → getBestEffort, else getRolledUp → 200 {"count": …}
              json(StatusCodes.NotImplemented, """{"error":"not implemented"}""")
            },
            delete {
              // TODO: clearBestEffort or clearRolledUp → 204
              json(StatusCodes.NotImplemented, """{"error":"not implemented"}""")
            },
          )
        },
      )
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("counters")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import counters.Tls // Tls.serverContext — provided
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AddRequest(delta: Option[Long], token: Option[String])

object CounterApi {
  /** Namespaces and their counter type (provided): configured per use case, never chosen per request. */
  val Namespaces = Map("views" -> "best_effort", "plays" -> "eventually_consistent")
  val NameRe = "^[A-Za-z0-9_-]{1,64}$".r
  val MaxDelta = 1000000L

  implicit val addFormat: RootJsonFormat[AddRequest] = jsonFormat2(AddRequest)

  /** Built in later steps. */
  def addBestEffort(ns: String, name: String, delta: Long): Long = ??? // step 2
  def getBestEffort(ns: String, name: String): Long = ???
  def clearBestEffort(ns: String, name: String): Unit = ???
  def appendEvent(ns: String, name: String, delta: Long, token: String): Unit = ??? // step 3
  def getRolledUp(ns: String, name: String): Long = ??? // step 4
  def clearRolledUp(ns: String, name: String): Unit = ???

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  private def validDelta(delta: Option[Long]): Boolean =
    delta.exists(d => d != 0 && d <= MaxDelta && d >= -MaxDelta)

  val route: Route =
    pathPrefix("counters" / Segment / Segment) { (ns, name) =>
      Namespaces.get(ns) match {
        case None => json(StatusCodes.NotFound, """{"error":"unknown namespace"}""")
        case Some(_) if !NameRe.matches(name) => json(StatusCodes.BadRequest, """{"error":"name must match [A-Za-z0-9_-]{1,64}"}""")
        case Some(kind) =>
          concat(
            path("add") {
              post {
                entity(as[AddRequest]) { req =>
                  if (!validDelta(req.delta))
                    json(StatusCodes.BadRequest, """{"error":"delta must be a non-zero integer within ±1000000"}""")
                  else if (kind == "best_effort") {
                    val count = addBestEffort(ns, name, req.delta.get)
                    json(StatusCodes.OK, s"""{"count":$count}""")
                  } else
                    req.token.filter(_.nonEmpty) match {
                      case None => json(StatusCodes.BadRequest, """{"error":"token is required: it is what makes a retry safe"}""")
                      case Some(token) =>
                        appendEvent(ns, name, req.delta.get, token)
                        json(StatusCodes.Accepted, """{"accepted":true}""")
                    }
                }
              }
            },
            pathEnd {
              concat(
                get {
                  val count = if (kind == "best_effort") getBestEffort(ns, name) else getRolledUp(ns, name)
                  json(StatusCodes.OK, s"""{"count":$count}""")
                },
                delete {
                  if (kind == "best_effort") clearBestEffort(ns, name) else clearRolledUp(ns, name)
                  complete(StatusCodes.NoContent)
                },
              )
            },
          )
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("counters")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <map>
#include <regex>
#include <string>

using json = nlohmann::json;

// Namespaces and their counter type (provided): configured per use case, never chosen per request.
const std::map<std::string, std::string> kNamespaces = {
    {"views", "best_effort"},
    {"plays", "eventually_consistent"},
};
const std::regex kNameRe(R"(^[A-Za-z0-9_-]{1,64}$)");
constexpr long long kMaxDelta = 1000000;

// Built in later steps.
long long add_best_effort(const std::string& ns, const std::string& name, long long delta);  // step 2
long long get_best_effort(const std::string& ns, const std::string& name);
void clear_best_effort(const std::string& ns, const std::string& name);
void append_event(const std::string& ns, const std::string& name, long long delta, const std::string& token);  // step 3
long long get_rolled_up(const std::string& ns, const std::string& name);  // step 4
void clear_rolled_up(const std::string& ns, const std::string& name);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/counters/([^/]+)/([^/]+)/add)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string ns = req.matches[1], name = req.matches[2];
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: 404 unless kNamespaces has ns; 400 unless std::regex_match(name, kNameRe)
    // TODO: 400 unless "delta" is an integer, non-zero and within ±kMaxDelta; eventually_consistent → 400 without "token"
    // TODO: best_effort → add_best_effort → 200 {"count": …}
    // TODO: eventually_consistent → append_event → 202 {"accepted": true}
    res.status = 501;
  });

  svr.Get(R"(/counters/([^/]+)/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string ns = req.matches[1], name = req.matches[2];
    // TODO: same 404 / 400; best_effort → get_best_effort, else get_rolled_up → 200 {"count": …}
    res.status = 501;
  });

  svr.Delete(R"(/counters/([^/]+)/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string ns = req.matches[1], name = req.matches[2];
    // TODO: same 404 / 400; clear_best_effort or clear_rolled_up → 204
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <map>
#include <regex>
#include <string>

using json = nlohmann::json;

// Namespaces and their counter type (provided): configured per use case, never chosen per request.
const std::map<std::string, std::string> kNamespaces = {
    {"views", "best_effort"},
    {"plays", "eventually_consistent"},
};
const std::regex kNameRe(R"(^[A-Za-z0-9_-]{1,64}$)");
constexpr long long kMaxDelta = 1000000;

// Built in later steps.
long long add_best_effort(const std::string& ns, const std::string& name, long long delta);  // step 2
long long get_best_effort(const std::string& ns, const std::string& name);
void clear_best_effort(const std::string& ns, const std::string& name);
void append_event(const std::string& ns, const std::string& name, long long delta, const std::string& token);  // step 3
long long get_rolled_up(const std::string& ns, const std::string& name);  // step 4
void clear_rolled_up(const std::string& ns, const std::string& name);

static void fail(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json{{"error", error}}.dump(), "application/json");
}

// The namespace's counter type, or "" once the shared 404 / 400 has been answered.
static std::string resolve(const std::string& ns, const std::string& name, httplib::Response& res) {
  const auto it = kNamespaces.find(ns);
  if (it == kNamespaces.end()) {
    fail(res, 404, "unknown namespace");
    return "";
  }
  if (!std::regex_match(name, kNameRe)) {
    fail(res, 400, "name must match [A-Za-z0-9_-]{1,64}");
    return "";
  }
  return it->second;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/counters/([^/]+)/([^/]+)/add)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string ns = req.matches[1], name = req.matches[2];
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const std::string kind = resolve(ns, name, res);
    if (kind.empty()) return;
    const long long delta = body.value("delta", 0LL);
    if (!body["delta"].is_number_integer() || delta == 0 || delta > kMaxDelta || delta < -kMaxDelta) {
      fail(res, 400, "delta must be a non-zero integer within ±1000000");
      return;
    }
    if (kind == "best_effort") {
      res.status = 200;
      res.set_content(json{{"count", add_best_effort(ns, name, delta)}}.dump(), "application/json");
      return;
    }
    const std::string token = body.value("token", "");
    if (token.empty()) {
      fail(res, 400, "token is required: it is what makes a retry safe");
      return;
    }
    append_event(ns, name, delta, token);
    res.status = 202;
    res.set_content(R"({"accepted":true})", "application/json");
  });

  svr.Get(R"(/counters/([^/]+)/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string ns = req.matches[1], name = req.matches[2];
    const std::string kind = resolve(ns, name, res);
    if (kind.empty()) return;
    const long long count = kind == "best_effort" ? get_best_effort(ns, name) : get_rolled_up(ns, name);
    res.status = 200;
    res.set_content(json{{"count", count}}.dump(), "application/json");
  });

  svr.Delete(R"(/counters/([^/]+)/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string ns = req.matches[1], name = req.matches[2];
    const std::string kind = resolve(ns, name, res);
    if (kind.empty()) return;
    if (kind == "best_effort")
      clear_best_effort(ns, name);
    else
      clear_rolled_up(ns, name);
    res.status = 204;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `def _api(ctx):
    """The API with the later steps replaced by fakes that record every call."""
    m = ctx.load("counter_api")
    calls = []
    best = {}
    rolled = {"plays:stranger-things": 1207}

    def add_best_effort(ns, name, delta):
        calls.append(("add_best_effort", ns, name, delta))
        best[f"{ns}:{name}"] = best.get(f"{ns}:{name}", 0) + delta
        return best[f"{ns}:{name}"]

    def get_best_effort(ns, name):
        calls.append(("get_best_effort", ns, name))
        return best.get(f"{ns}:{name}", 0)

    def clear_best_effort(ns, name):
        calls.append(("clear_best_effort", ns, name))
        best.pop(f"{ns}:{name}", None)

    def append_event(ns, name, delta, token):
        calls.append(("append_event", ns, name, delta, token))

    def get_rolled_up(ns, name):
        calls.append(("get_rolled_up", ns, name))
        return rolled.get(f"{ns}:{name}", 0)

    def clear_rolled_up(ns, name):
        calls.append(("clear_rolled_up", ns, name))
        rolled.pop(f"{ns}:{name}", None)

    m.add_best_effort = add_best_effort
    m.get_best_effort = get_best_effort
    m.clear_best_effort = clear_best_effort
    m.append_event = append_event
    m.get_rolled_up = get_rolled_up
    m.clear_rolled_up = clear_rolled_up
    return m, calls


async def check_routes(ctx):
    m, calls = _api(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/counters/views/trailer-7/add", json={"delta": 1, "token": "t-1"})
        assert r.status_code not in (404, 405), f"POST /counters/views/trailer-7/add answered {r.status_code}: no handler is registered for it"
        assert r.status_code == 200, f"a best-effort add answered {r.status_code}, expected 200"
        r = await c.get("/counters/views/trailer-7")
        assert r.status_code not in (404, 405), f"GET /counters/views/trailer-7 answered {r.status_code}: no handler is registered for it"
        assert r.status_code == 200, f"GET on a configured namespace answered {r.status_code}, expected 200"
        r = await c.delete("/counters/views/trailer-7")
        assert r.status_code not in (404, 405), f"DELETE /counters/views/trailer-7 answered {r.status_code}: no handler is registered for it"
        assert r.status_code == 204, f"DELETE answered {r.status_code}, expected 204"


async def check_unknown_namespace(ctx):
    m, calls = _api(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/counters/likes/trailer-7/add", json={"delta": 1, "token": "t-1"})
        assert r.status_code == 404, f"namespace 'likes' is not configured: expected 404, got {r.status_code}"
        r = await c.get("/counters/likes/trailer-7")
        assert r.status_code == 404, f"GET on an unknown namespace answered {r.status_code}, expected 404"
        r = await c.delete("/counters/likes/trailer-7")
        assert r.status_code == 404, f"DELETE on an unknown namespace answered {r.status_code}, expected 404"
        r = await c.post("/counters/likes/bad name/add", json={"delta": 0})
        assert r.status_code == 404, f"the namespace is checked first: an unknown namespace with a bad name and a bad delta is still a 404, got {r.status_code}"
    assert calls == [], f"an unknown namespace must be refused before any store is touched, calls: {calls}"


async def check_validate(ctx):
    m, calls = _api(ctx)
    async with ctx.client(m.app) as c:
        for bad in ("bad name", "dots.are.out", "a" * 65, "caf\u00e9"):
            r = await c.post(f"/counters/views/{bad}/add", json={"delta": 1, "token": "t-1"})
            assert r.status_code == 400, f"name {bad!r} does not match NAME_RE: expected 400, got {r.status_code}"
            r = await c.get(f"/counters/views/{bad}")
            assert r.status_code == 400, f"GET with name {bad!r} answered {r.status_code}, expected 400"
        for delta in (0, 1_000_001, -1_000_001):
            r = await c.post("/counters/views/trailer-7/add", json={"delta": delta, "token": "t-1"})
            assert r.status_code == 400, f"delta {delta} is zero or beyond ±MAX_DELTA: expected 400, got {r.status_code}"
        r = await c.post("/counters/plays/stranger-things/add", json={"delta": 1})
        assert r.status_code == 400, f"an eventually-consistent add without a token answered {r.status_code}, expected 400: the token is the idempotency key"
        r = await c.post("/counters/plays/stranger-things/add", json={"delta": 1, "token": ""})
        assert r.status_code == 400, f"an empty token is no token: expected 400, got {r.status_code}"
        assert calls == [], f"a rejected request must not reach any store, calls: {calls}"
        r = await c.post("/counters/views/trailer-7/add", json={"delta": -1_000_000})
        assert r.status_code == 200, f"a best-effort add of exactly -MAX_DELTA without a token is valid: expected 200, got {r.status_code}"
        r = await c.post("/counters/views/trailer_7-v2/add", json={"delta": 1_000_000, "token": "t-1"})
        assert r.status_code == 200, f"name 'trailer_7-v2' and delta MAX_DELTA are valid: expected 200, got {r.status_code}"


async def check_add_dispatch(ctx):
    m, calls = _api(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/counters/views/trailer-7/add", json={"delta": 3, "token": "t-1"})
        assert r.status_code == 200, f"a best-effort add answered {r.status_code}, expected 200"
        assert r.json().get("count") == 3, f"the 200 body must carry the new count from add_best_effort, got {r.json()}"
        r = await c.post("/counters/views/trailer-7/add", json={"delta": 4})
        assert r.json().get("count") == 7, f"the second add must return the running count 7, got {r.json()}"
        assert calls == [("add_best_effort", "views", "trailer-7", 3), ("add_best_effort", "views", "trailer-7", 4)], f"best-effort adds go through add_best_effort only, calls: {calls}"
        calls.clear()
        r = await c.post("/counters/plays/stranger-things/add", json={"delta": 1, "token": "t-9f3"})
        assert r.status_code == 202, f"an eventually-consistent add answered {r.status_code}, expected 202: the count is not visible yet"
        assert calls == [("append_event", "plays", "stranger-things", 1, "t-9f3")], f"an eventually-consistent add is one append_event carrying the token, calls: {calls}"
        assert "count" not in r.json(), f"a 202 must not claim a count the rollup has not computed, got {r.json()}"


async def check_read_clear_dispatch(ctx):
    m, calls = _api(ctx)
    async with ctx.client(m.app) as c:
        await c.post("/counters/views/trailer-7/add", json={"delta": 5})
        calls.clear()
        r = await c.get("/counters/views/trailer-7")
        assert r.status_code == 200 and r.json().get("count") == 5, f"GET on a best-effort counter must answer 200 with the count 5, got {r.status_code} {r.json()}"
        assert calls == [("get_best_effort", "views", "trailer-7")], f"a best-effort read is one get_best_effort, calls: {calls}"
        calls.clear()
        r = await c.get("/counters/plays/stranger-things")
        assert r.status_code == 200 and r.json().get("count") == 1207, f"GET on an eventually-consistent counter must answer 200 with the rolled-up 1207, got {r.status_code} {r.json()}"
        assert calls == [("get_rolled_up", "plays", "stranger-things")], f"an eventually-consistent read is one get_rolled_up, calls: {calls}"
        calls.clear()
        r = await c.delete("/counters/views/trailer-7")
        assert r.status_code == 204, f"DELETE on a best-effort counter answered {r.status_code}, expected 204"
        assert calls == [("clear_best_effort", "views", "trailer-7")], f"a best-effort clear is one clear_best_effort, calls: {calls}"
        calls.clear()
        r = await c.delete("/counters/plays/stranger-things")
        assert r.status_code == 204, f"DELETE on an eventually-consistent counter answered {r.status_code}, expected 204"
        assert calls == [("clear_rolled_up", "plays", "stranger-things")], f"an eventually-consistent clear is one clear_rolled_up, calls: {calls}"
        r = await c.get("/counters/plays/stranger-things")
        assert r.json().get("count") == 0, f"after the clear the counter reads 0, got {r.json()}"
`,
  },
  debrief: `The API is the whole abstraction: callers see AddCount, GetCount and ClearCount, and the namespace — not the request — decides which machinery runs. That is why the namespace is checked first and why the two adds answer differently: a 200 with a count is a promise that the number moved, a 202 is a promise that it will, and the second promise is the only one a durable log can make synchronously. The token is required only where it has a consumer; asking a cache to honour it would be a lie. Netflix's real control plane also configures cardinality and TTL per namespace, offers AddAndGetCount, and treats a clear as just another event in the log rather than a direct delete.`,
};
