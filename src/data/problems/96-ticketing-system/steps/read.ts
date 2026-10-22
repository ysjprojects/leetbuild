import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/tickets/{id}: visibility rules that actually apply',
  concept: 'http',
  file: 'read',
  focus: ['requester', 'agent', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a ticket page renders a
timeline, so the demo looks finished. It hands every note — internal ones included — to whoever
asks, it treats a requester and an agent identically, and it pages with \`limit\`/\`offset\`, so the
other half of the timeline shifts under a reader as notes arrive. Review it, fix it, and prove the
fix with the checks below.

Implement \`GET /v1/tickets/{ticket_id}\`, the read the requester's ticket page and the agent console
both call:

- The caller's role comes from \`X-Actor-Role\` (\`requester\` | \`agent\`); a missing or unknown role is
  **401**. \`limit\` defaults to 50 and must be **1–100** — anything outside that is **400**.
- The response is \`{"ticket_id", "notes", "next_cursor"}\`: the ticket's timeline page, ordered by the
  notes' monotonic \`seq\`, plus the opaque cursor for the following page (\`null\` when this page is the
  last one). A \`cursor\` that is not one the server issued is **400**, before the store is touched.
- Visibility applies to the page, not to the URL: an entry whose \`visibility\` is \`internal\` is for
  agents. A requester must **never** receive one; an agent receives the internal notes as well, so the
  agent console sees the whole timeline.
- Pagination is keyset, not \`offset\`. The store is provided and reads one keyset page:
  \`page(ticket_id, after_seq, limit)\` returns up to \`limit\` entries with \`seq > after_seq\`
  ascending by \`seq\`, each \`{seq, visibility, author, body}\` — and \`next_cursor\` encodes the \`seq\`
  of the last entry **fetched**. Two readers paging the same busy ticket must not see a note twice or
  miss one because fifteen notes arrived in between.

**Failure mode the checks target.** A read that returns every note to everyone is a one-line breach
of the promise the support product makes to its customers — internal notes are ours — and it does not
fail loudly when it ships; it fails the first time a customer opens the page. An \`offset\` page over
an append-only, busy timeline is a wrong-results bug that looks like a UI glitch: notes repeat, notes
vanish, and the reader is never told. A response with no cursor is what forces clients to invent
offsets in the first place, and filtering the page before deriving the cursor makes a requester ask
for the same page forever.`,
  sequence: {
    participants: ['Requester', 'Agent', 'Ticket API', 'Ticket store'],
    messages: [
      {from: 'Requester', to: 'Ticket API', label: 'GET /v1/tickets/tkt_8f · X-Actor-Role: requester', kind: 'sync'},
      {
        from: 'Ticket API',
        to: 'Ticket store',
        label: 'page(ticket_id, after_seq, limit) · keyset on seq',
        kind: 'sync',
      },
      {from: 'Ticket store', to: 'Ticket API', label: 'entries with seq > after_seq, ascending', kind: 'reply'},
      {from: 'Ticket API', to: 'Ticket API', label: 'drop visibility=internal for a requester', kind: 'sync'},
      {from: 'Ticket API', to: 'Requester', label: '200 {notes, next_cursor} · public entries only', kind: 'reply'},
      {from: 'Agent', to: 'Ticket API', label: 'GET /v1/tickets/tkt_8f · X-Actor-Role: agent', kind: 'sync'},
      {from: 'Ticket API', to: 'Agent', label: '200 {notes, next_cursor} · internal entries included', kind: 'reply'},
      {from: 'Requester', to: 'Ticket API', label: 'GET …?cursor=<seq of the last entry fetched>', kind: 'sync'},
      {
        from: 'Ticket API',
        to: 'Requester',
        label: '200 · notes appended meanwhile are neither repeated nor skipped',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'The role is an input like any other: `X-Actor-Role` must be `requester` or `agent` (401 otherwise), and it decides one thing — whether `visibility == "internal"` entries belong in the page. Filter the entries you fetched; there is no second read that knows the caller.',
    'A cursor is a position in the timeline, not a count of rows: `next_cursor` encodes the `seq` of the last entry you fetched, and the next request reads `seq > after_seq`. Encoding the last **visible** entry instead stalls a requester on a page of internal notes — the position never advances past them.',
    'Pagination and visibility have to compose: the store reads a keyset page of the raw timeline (`limit` entries, ascending by `seq`), the response carries the cursor of the last raw entry even when that entry was filtered out, and a page shorter than `limit` means the timeline is exhausted, so `next_cursor` is `null`.',
  ],
  checks: [
    {
      id: 'read-endpoint',
      title: 'Serves GET /v1/tickets/{id} with the timeline page',
      detail:
        'The read is registered on `GET /v1/tickets/{ticket_id}` (the language’s path-parameter route) and answers with the ticket’s `notes`. The draft already answers this route, so this check passes on it — the four below are where it fails.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/tickets\/\{ticket_id\}["']/, /"notes"/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/tickets\/:ticketId['"]/, /notes\s*[,}]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/tickets\/\{id\}"/, /"notes"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tickets"\s*\/\s*Segment\s*\)/, /\bget\s*\{/, /notes\s*[,)]/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/tickets\//, /"notes"/]},
      },
    },
    {
      id: 'internal-hidden',
      title: 'A requester never receives an internal note',
      detail:
        'The role is read from `X-Actor-Role` and decides visibility: an entry whose `visibility` is `internal` is dropped unless the caller is an agent, so a requester’s page carries public entries only. The draft returns every note to every caller.',
      match: {
        python: {all: [/X-Actor-Role/, /visibility["']\]\s*!=\s*["']internal["']/]},
        typescript: {all: [/x-actor-role/, /visibility\s*!==\s*'internal'/]},
        go: {all: [/X-Actor-Role/, /Visibility\s*!=\s*"internal"/]},
        scala: {all: [/X-Actor-Role/, /visibility\s*!=\s*"internal"/]},
        cpp: {all: [/X-Actor-Role/, /value\("visibility",\s*std::string\(\)\)\s*!=\s*"internal"/]},
      },
    },
    {
      id: 'agent-sees-internal',
      title: 'An agent receives the internal notes too',
      detail:
        'The page is built with an include-internal flag — `include_internal`, or `includeInternal` in the typed languages — true exactly for `X-Actor-Role: agent`, and the page is fetched once for both callers, so an agent’s response contains the internal notes. The draft has no agent path at all — it returns everything to everyone, which is why nothing distinguishes the two callers.',
      match: {
        python: {all: [/include_internal\s*=\s*role\s*==\s*["']agent["']/, /store\.page\(/]},
        typescript: {all: [/includeInternal\s*=\s*role\s*===\s*'agent'/, /store\.page\(/]},
        go: {all: [/includeInternal\s*:?=\s*role\s*==\s*"agent"/, /store\.Page\(/]},
        scala: {all: [/includeInternal\s*=\s*role\s*==\s*"agent"/, /TicketTimeline\.page\(/]},
        cpp: {all: [/includeInternal\s*=\s*role\s*==\s*"agent"/, /store\.page\(/]},
      },
    },
    {
      id: 'cursor-pagination',
      title: 'Pages by cursor, never by offset',
      detail:
        'The request takes `cursor` — the opaque value a previous page issued — and the response carries `next_cursor` for the following page. There is no `offset` parameter and no offset in the store read: the draft pages with `limit`/`offset`, so a busy ticket shifts pages under the reader.',
      match: {
        python: {all: [/cursor/, /next_cursor/], none: [/offset/i]},
        typescript: {all: [/cursor/, /next_cursor/], none: [/offset/i]},
        go: {all: [/cursor/, /next_cursor/], none: [/offset/i]},
        scala: {all: [/cursor/, /next_cursor/], none: [/offset/i]},
        cpp: {all: [/cursor/, /next_cursor/], none: [/offset/i]},
      },
    },
    {
      id: 'stable-cursor',
      title: 'The cursor is keyset-stable across pages',
      detail:
        'The page is a keyset read — `seq > after_seq`, ascending by `seq` — and `next_cursor` encodes the `seq` of the last entry **fetched**, so notes appended between two pages neither repeat nor vanish, and a requester’s page still advances when the raw page was full of internal notes.',
      match: {
        python: {
          all: [/after_seq/, /encode_cursor\(\s*entries\[-1\]\[["']seq["']\]\s*\)/],
          order: [/store\.page\(/, /encode_cursor\(\s*entries\[-1\]\[["']seq["']\]\s*\)/],
        },
        typescript: {
          all: [/afterSeq/, /encodeCursor\(\s*entries\[entries\.length\s*-\s*1\]\.seq\s*\)/],
          order: [/store\.page\(/, /encodeCursor\(\s*entries\[entries\.length\s*-\s*1\]\.seq\s*\)/],
        },
        go: {
          all: [/afterSeq/, /encodeCursor\(entries\[len\(entries\)-1\]\.Seq\)/],
          order: [/store\.Page\(/, /encodeCursor\(entries\[len\(entries\)-1\]\.Seq\)/],
        },
        scala: {
          all: [/afterSeq/, /encodeCursor\(entries\.last\.seq\)/],
          order: [/TicketTimeline\.page\(/, /encodeCursor\(entries\.last\.seq\)/],
        },
        cpp: {
          all: [/afterSeq/, /encodeCursor\(entries\.back\(\)\.value\("seq"/],
          order: [/store\.page\(/, /encodeCursor\(entries\.back\(\)\.value\("seq"/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

app = FastAPI()


class TicketTimeline:
    def page(self, ticket_id: str, limit: int, offset: int) -> list[dict]:
        """The ticket's notes in page order: limit rows from offset."""
        raise NotImplementedError


store = TicketTimeline()


@app.get("/v1/tickets/{ticket_id}")
def read_ticket(ticket_id: str, limit: int = Query(50), offset: int = Query(0)) -> JSONResponse:
    # TODO: this draft hands every note — internal ones included — to every caller, treats a
    # requester and an agent alike, and pages with limit/offset, so notes appended while a reader
    # is paging push the rest of the timeline forward. Read the role from X-Actor-Role, drop
    # internal notes for requesters, keep them for agents, and page by a cursor over the notes' seq.
    notes = store.page(ticket_id, limit, offset)
    return JSONResponse({"ticket_id": ticket_id, "notes": notes}, status_code=200)
`,
      solution: `import base64
import binascii

from fastapi import FastAPI, Header, HTTPException, Query

app = FastAPI()

DEFAULT_LIMIT = 50
MAX_LIMIT = 100
ROLES = ("requester", "agent")


class TicketTimeline:
    def page(self, ticket_id: str, after_seq: int, limit: int) -> list[dict]:
        """The ticket's notes with seq > after_seq, ascending by seq — a keyset page."""
        raise NotImplementedError


store = TicketTimeline()


def encode_cursor(seq: int) -> str:
    return base64.urlsafe_b64encode(f"seq:{seq}".encode()).decode()


def decode_cursor(cursor: str) -> int:
    """The seq a cursor points past; a cursor we did not issue is a 400, never a 500."""
    try:
        text = base64.urlsafe_b64decode(cursor.encode()).decode()
    except (binascii.Error, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="invalid cursor")
    if not text.startswith("seq:") or not text[4:].isdigit():
        raise HTTPException(status_code=400, detail="invalid cursor")
    return int(text[4:])


@app.get("/v1/tickets/{ticket_id}")
def read_ticket(
    ticket_id: str,
    role: str | None = Header(default=None, alias="X-Actor-Role"),
    limit: int = Query(DEFAULT_LIMIT),
    cursor: str | None = Query(default=None),
) -> dict:
    if role not in ROLES:
        raise HTTPException(status_code=401, detail="X-Actor-Role must be requester or agent")
    if limit < 1 or limit > MAX_LIMIT:
        raise HTTPException(status_code=400, detail=f"limit must be 1..{MAX_LIMIT}")
    after_seq = decode_cursor(cursor) if cursor is not None else 0
    entries = store.page(ticket_id, after_seq, limit)
    include_internal = role == "agent"
    notes = [entry for entry in entries if include_internal or entry["visibility"] != "internal"]
    next_cursor = encode_cursor(entries[-1]["seq"]) if len(entries) == limit else None
    return {"ticket_id": ticket_id, "notes": notes, "next_cursor": next_cursor}
`,
    },
    typescript: {
      starter: `/** GET /v1/tickets/:ticketId: a model-generated draft that hides nothing and pages by offset. */
import Fastify from 'fastify';

export const app = Fastify();

interface TimelineEntry {
  seq: number;
  visibility: string;
  author: string;
  body: string;
}

class TicketTimeline {
  /** The ticket's notes in page order: limit rows from offset. */
  async page(ticketId: string, limit: number, offset: number): Promise<TimelineEntry[]> {
    throw new Error('not implemented');
  }
}

const store = new TicketTimeline();

app.get('/v1/tickets/:ticketId', async (request, reply) => {
  // TODO: this draft hands every note — internal ones included — to every caller, treats a
  // requester and an agent alike, and pages with limit/offset, so notes appended while a reader
  // is paging push the rest of the timeline forward. Read the role from X-Actor-Role, drop
  // internal notes for requesters, keep them for agents, and page by a cursor over the notes' seq.
  const {ticketId} = request.params as {ticketId: string};
  const query = request.query as {limit?: string; offset?: string};
  const limit = Number(query.limit ?? 50);
  const offset = Number(query.offset ?? 0);
  const notes = await store.page(ticketId, limit, offset);
  return reply.code(200).send({ticket_id: ticketId, notes});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/tickets/:ticketId: the timeline page a requester and an agent may each see. */
import Fastify from 'fastify';

export const app = Fastify();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface TimelineEntry {
  seq: number;
  visibility: string;
  author: string;
  body: string;
}

class TicketTimeline {
  /** The ticket's notes with seq > afterSeq, ascending by seq — a keyset page. */
  async page(ticketId: string, afterSeq: number, limit: number): Promise<TimelineEntry[]> {
    throw new Error('not implemented');
  }
}

const store = new TicketTimeline();

function encodeCursor(seq: number): string {
  return Buffer.from(\`seq:\${seq}\`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  const match = /^seq:(\\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match === null ? null : Number(match[1]);
}

app.get('/v1/tickets/:ticketId', async (request, reply) => {
  const role = request.headers['x-actor-role'];
  if (role !== 'requester' && role !== 'agent')
    return reply.code(401).send({error: 'X-Actor-Role must be requester or agent'});
  const {ticketId} = request.params as {ticketId: string};
  const query = request.query as {limit?: string; cursor?: string};
  const limit = Number(query.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    return reply.code(400).send({error: \`limit must be 1..\${MAX_LIMIT}\`});
  const afterSeq = query.cursor === undefined ? 0 : decodeCursor(query.cursor);
  if (afterSeq === null) return reply.code(400).send({error: 'invalid cursor'});
  const entries = await store.page(ticketId, afterSeq, limit);
  const includeInternal = role === 'agent';
  const notes = entries.filter(entry => includeInternal || entry.visibility !== 'internal');
  const nextCursor = entries.length === limit ? encodeCursor(entries[entries.length - 1].seq) : null;
  return reply.code(200).send({ticket_id: ticketId, notes, next_cursor: nextCursor});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

type TimelineEntry struct {
	Seq        int64  \`json:"seq"\`
	Visibility string \`json:"visibility"\`
	Author     string \`json:"author"\`
	Body       string \`json:"body"\`
}

type TicketTimeline struct{}

// Page returns the ticket's notes in page order: limit rows from offset.
func (t *TicketTimeline) Page(ctx context.Context, ticketID string, limit, offset int) ([]TimelineEntry, error) {
	return nil, nil
}

var store = &TicketTimeline{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readTicket(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft hands every note — internal ones included — to every caller, treats a
	// requester and an agent alike, and pages with limit/offset, so notes appended while a reader
	// is paging push the rest of the timeline forward. Read the role from X-Actor-Role, drop
	// internal notes for requesters, keep them for agents, and page by a cursor over the notes' seq.
	ticketID := r.PathValue("id")
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			offset = n
		}
	}
	notes, _ := store.Page(r.Context(), ticketID, limit, offset)
	writeJSON(rw, http.StatusOK, map[string]any{"ticket_id": ticketID, "notes": notes})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/tickets/{id}", readTicket)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
)

const (
	defaultLimit = 50
	maxLimit     = 100
)

type TimelineEntry struct {
	Seq        int64  \`json:"seq"\`
	Visibility string \`json:"visibility"\`
	Author     string \`json:"author"\`
	Body       string \`json:"body"\`
}

type TicketTimeline struct{}

// Page returns the ticket's notes with Seq > afterSeq, ascending by Seq — a keyset page.
func (t *TicketTimeline) Page(ctx context.Context, ticketID string, afterSeq int64, limit int) ([]TimelineEntry, error) {
	return nil, nil
}

var store = &TicketTimeline{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func encodeCursor(seq int64) string {
	return base64.URLEncoding.EncodeToString([]byte("seq:" + strconv.FormatInt(seq, 10)))
}

// decodeCursor returns the seq a cursor points past; a cursor we did not issue is an error.
func decodeCursor(cursor string) (int64, error) {
	raw, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, errors.New("invalid cursor")
	}
	value, ok := strings.CutPrefix(string(raw), "seq:")
	if !ok {
		return 0, errors.New("invalid cursor")
	}
	seq, convErr := strconv.ParseInt(value, 10, 64)
	if convErr != nil || seq < 0 {
		return 0, errors.New("invalid cursor")
	}
	return seq, nil
}

func readTicket(rw http.ResponseWriter, r *http.Request) {
	role := r.Header.Get("X-Actor-Role")
	if role != "requester" && role != "agent" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Actor-Role must be requester or agent"})
		return
	}
	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxLimit {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "limit must be 1..100"})
			return
		}
		limit = n
	}
	var afterSeq int64
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		seq, err := decodeCursor(raw)
		if err != nil {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid cursor"})
			return
		}
		afterSeq = seq
	}
	ticketID := r.PathValue("id")
	entries, err := store.Page(r.Context(), ticketID, afterSeq, limit)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	includeInternal := role == "agent"
	notes := make([]TimelineEntry, 0, len(entries))
	for _, entry := range entries {
		if includeInternal || entry.Visibility != "internal" {
			notes = append(notes, entry)
		}
	}
	var nextCursor *string
	if len(entries) == limit {
		encoded := encodeCursor(entries[len(entries)-1].Seq)
		nextCursor = &encoded
	}
	writeJSON(rw, http.StatusOK, map[string]any{"ticket_id": ticketID, "notes": notes, "next_cursor": nextCursor})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/tickets/{id}", readTicket)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TimelineEntry(seq: Long, visibility: String, author: String, body: String)
final case class TimelinePage(ticket_id: String, notes: List[TimelineEntry])

object TicketTimeline {
  /** The ticket's notes in page order: limit rows from offset. */
  def page(ticketId: String, limit: Int, offset: Int): List[TimelineEntry] = Nil
}

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("ticketd")
  implicit val entryFormat: RootJsonFormat[TimelineEntry] = jsonFormat4(TimelineEntry)
  implicit val pageFormat: RootJsonFormat[TimelinePage] = jsonFormat2(TimelinePage)

  val DefaultLimit = 50

  val route: Route =
    path("v1" / "tickets" / Segment) { ticketId =>
      get {
        parameters("limit".as[Int].withDefault(DefaultLimit), "offset".as[Int].withDefault(0)) { (limit, offset) =>
          // TODO: this draft hands every note — internal ones included — to every caller, treats a
          // requester and an agent alike, and pages with offset, so notes appended while a reader
          // is paging push the rest of the timeline forward. Read the role from X-Actor-Role, drop
          // internal notes for requesters, keep them for agents, and page by a cursor over seq.
          val notes = TicketTimeline.page(ticketId, limit, offset)
          complete(StatusCodes.OK, TimelinePage(ticketId, notes))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.util.Base64

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TimelineEntry(seq: Long, visibility: String, author: String, body: String)
final case class TimelinePage(ticket_id: String, notes: List[TimelineEntry], next_cursor: Option[String])

object TicketTimeline {
  /** The ticket's notes with seq > afterSeq, ascending by seq — a keyset page. */
  def page(ticketId: String, afterSeq: Long, limit: Int): List[TimelineEntry] = Nil
}

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("ticketd")
  implicit val entryFormat: RootJsonFormat[TimelineEntry] = jsonFormat4(TimelineEntry)
  implicit val pageFormat: RootJsonFormat[TimelinePage] = jsonFormat3(TimelinePage)

  val DefaultLimit = 50
  val MaxLimit = 100

  def encodeCursor(seq: Long): String =
    Base64.getUrlEncoder.encodeToString(s"seq:$seq".getBytes(StandardCharsets.UTF_8))

  /** The seq a cursor points past; a cursor we did not issue is a 400, never a 500. */
  def decodeCursor(cursor: String): Option[Long] =
    try {
      val text = new String(Base64.getUrlDecoder.decode(cursor), StandardCharsets.UTF_8)
      if (text.startsWith("seq:")) text.stripPrefix("seq:").toLongOption.filter(_ >= 0) else None
    } catch {
      case _: IllegalArgumentException => None
    }

  val route: Route =
    path("v1" / "tickets" / Segment) { ticketId =>
      get {
        optionalHeaderValueByName("X-Actor-Role") { roleOpt =>
          parameters("limit".as[Int].withDefault(DefaultLimit), "cursor".optional) { (limit, cursor) =>
            val role = roleOpt.getOrElse("")
            if (role != "requester" && role != "agent") {
              complete(StatusCodes.Unauthorized, """{"error":"X-Actor-Role must be requester or agent"}""")
            } else if (limit < 1 || limit > MaxLimit) {
              complete(StatusCodes.BadRequest, s"""{"error":"limit must be 1..$MaxLimit"}""")
            } else {
              val decoded = cursor.map(decodeCursor).getOrElse(Some(0L))
              decoded match {
                case None =>
                  complete(StatusCodes.BadRequest, """{"error":"invalid cursor"}""")
                case Some(afterSeq) =>
                  val entries = TicketTimeline.page(ticketId, afterSeq, limit)
                  val includeInternal = role == "agent"
                  val notes = entries.filter(entry => includeInternal || entry.visibility != "internal")
                  val next = if (entries.length == limit) Some(encodeCursor(entries.last.seq)) else None
                  complete(StatusCodes.OK, TimelinePage(ticketId, notes, next))
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

struct TicketTimeline {
  /** The ticket's notes in page order: limit rows from offset. */
  json page(const std::string& ticketId, int limit, int offset);
};

TicketTimeline store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/tickets/([A-Za-z0-9_-]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft hands every note — internal ones included — to every caller, treats a
    // requester and an agent alike, and pages with limit/offset, so notes appended while a reader
    // is paging push the rest of the timeline forward. Read the role from X-Actor-Role, drop
    // internal notes for requesters, keep them for agents, and page by a cursor over the notes' seq.
    const auto ticketId = req.matches[1].str();
    const int limit = req.has_param("limit") ? std::stoi(req.get_param_value("limit")) : 50;
    const int offset = req.has_param("offset") ? std::stoi(req.get_param_value("offset")) : 0;
    const auto notes = store.page(ticketId, limit, offset);
    res.status = 200;
    res.set_content(json{{"ticket_id", ticketId}, {"notes", notes}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kDefaultLimit = 50;
constexpr int kMaxLimit = 100;

struct TicketTimeline {
  /** The ticket's notes with seq > afterSeq, ascending by seq — a keyset page. */
  json page(const std::string& ticketId, long long afterSeq, int limit);
};

TicketTimeline store;

std::string base64Encode(const std::string& in) {
  static const std::string kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  int value = 0;
  int bits = -6;
  for (const unsigned char c : in) {
    value = (value << 8) + static_cast<int>(c);
    bits += 8;
    while (bits >= 0) {
      out.push_back(kAlphabet[(value >> bits) & 0x3F]);
      bits -= 6;
    }
  }
  if (bits > -6) out.push_back(kAlphabet[((value << 8) >> (bits + 8)) & 0x3F]);
  return out;
}

std::optional<std::string> base64Decode(const std::string& in) {
  static const std::string kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  int value = 0;
  int bits = -8;
  for (char c : in) {
    if (c == '=') break;
    const auto pos = kAlphabet.find(c);
    if (pos == std::string::npos) return std::nullopt;
    value = (value << 6) + static_cast<int>(pos);
    bits += 6;
    if (bits >= 0) {
      out.push_back(static_cast<char>((value >> bits) & 0xFF));
      bits -= 8;
    }
  }
  return out;
}

std::string encodeCursor(long long seq) {
  return base64Encode("seq:" + std::to_string(seq));
}

/** The seq a cursor points past; a cursor we did not issue is a 400, never a 500. */
std::optional<long long> decodeCursor(const std::string& raw) {
  const auto text = base64Decode(raw);
  if (!text || text->rfind("seq:", 0) != 0) return std::nullopt;
  const auto digits = text->substr(4);
  if (digits.empty()) return std::nullopt;
  for (char c : digits) {
    if (c < '0' || c > '9') return std::nullopt;
  }
  return std::stoll(digits);
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/tickets/([A-Za-z0-9_-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto role = req.get_header_value("X-Actor-Role");
    if (role != "requester" && role != "agent") {
      res.status = 401;
      res.set_content(R"({"error":"X-Actor-Role must be requester or agent"})", "application/json");
      return;
    }
    int limit = kDefaultLimit;
    if (req.has_param("limit")) {
      limit = std::atoi(req.get_param_value("limit").c_str());
      if (limit < 1 || limit > kMaxLimit) {
        res.status = 400;
        res.set_content(R"({"error":"limit must be 1..100"})", "application/json");
        return;
      }
    }
    long long afterSeq = 0;
    if (req.has_param("cursor")) {
      const auto parsed = decodeCursor(req.get_param_value("cursor"));
      if (!parsed) {
        res.status = 400;
        res.set_content(R"({"error":"invalid cursor"})", "application/json");
        return;
      }
      afterSeq = *parsed;
    }
    const auto ticketId = req.matches[1].str();
    const auto entries = store.page(ticketId, afterSeq, limit);
    const bool includeInternal = role == "agent";
    json notes = json::array();
    for (const auto& entry : entries) {
      if (includeInternal || entry.value("visibility", std::string()) != "internal") notes.push_back(entry);
    }
    const auto next = entries.size() == static_cast<std::size_t>(limit)
                          ? json(encodeCursor(entries.back().value("seq", 0LL)))
                          : json(nullptr);
    res.status = 200;
    res.set_content(
        json{{"ticket_id", ticketId}, {"notes", notes}, {"next_cursor", next}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question is whether you see the two contracts a timeline read owes its callers — who may see what, and where a page ends — and that they interact. Visibility first: the role arrives in \`X-Actor-Role\`, and the only place that can safely apply it is the page the endpoint builds, because the store does not know the caller. Drafts that "filter later" — in a serializer, in a template, in a second query — leak the first time a field or a caller is added; the check is the one the customer will run, not you. Pagination second: \`LIMIT/OFFSET\` is stable for a frozen dataset and unstable for a live one. A ticket that receives notes while a reader pages shifts every later offset, so notes repeat or vanish — and because the reader cannot tell, it reads as a UI glitch. A keyset cursor over the monotonic \`seq\` (the value that already exists for ordering) names a position instead of a row number, so appends cannot move it. The trap is the composition: filter internal notes before deriving the cursor and a requester whose page was half internal asks for the next page from a position that never advanced, and the endpoint serves the same page forever. Real platforms sign cursors so a client cannot forge a position, cap \`limit\` per plan, and expose the timeline as a per-ticket append-only log whose ordering the store guarantees.`,
};
