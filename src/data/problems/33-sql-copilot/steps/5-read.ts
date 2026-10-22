import type {Step} from '@/lib/types';

export const sqlReadStep: Step = {
  id: 'read',
  title: 'GET /v1/queries/{id}/results: read-only execution with a row cap',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'replica'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers
\`GET /v1/queries/{id}/results\`, reads a statement the caller supplies and answers with rows. It
compiles, it serves the demo, and it is the most dangerous file in the product. Review it like the
service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/queries/{id}/results\` — the endpoint that executes a **previously validated**
statement and returns one page of its results.

- The statement is looked up by id from the record written when generation was validated
  (\`store.get(query_id)\`); the SQL never travels in the request. A caller who can name the SQL can
  name \`DROP TABLE\`.
- The request carries only the page address: an optional \`cursor\`, a **server-held opaque token**
  the server itself issued for the previous page. A caller-supplied \`LIMIT\`/\`OFFSET\` is not a page
  address; it is query shape handed to the caller.
- Before anything runs, the statement is checked with \`has_second_statement\`: a payload carrying a
  second statement after a semicolon is **400**. That is exactly how a caller-supplied \`LIMIT\` gets
  removed — a trailing \`; DELETE …\` turns a page read into a write.
- The row cap is enforced server-side: \`MAX_ROWS = 5000\` caps every page whatever the SQL asks for,
  so a statement that says \`LIMIT 1000000\` still returns at most 5000 rows.
- Execution happens on the **read replica** inside \`SET TRANSACTION READ ONLY\`, so even a mistake
  that reaches a connection cannot write.
- The response is \`{rows, next_cursor}\`: the cursor is opaque and server-issued, and paging stays
  stable because the offset lives inside it rather than in the caller's SQL.

**Failure mode the checks target.** The draft accepts a statement in the request body and runs it on
the primary, returns unbounded rows, and honors a caller-supplied \`LIMIT\` that a second statement
after a semicolon can remove. Four independent defects: caller-controlled SQL, no single-statement
guard, no row cap, and no read-only replica.`,
  sequence: {
    participants: ['Client', 'SQL Copilot', 'Read replica'],
    messages: [
      {from: 'Client', to: 'SQL Copilot', label: 'GET /v1/queries/q_123/results?cursor=cm93OjUwMDA', kind: 'sync'},
      {
        from: 'SQL Copilot',
        to: 'SQL Copilot',
        label: 'store.get(query_id) · the validated statement; no SQL in the request',
        kind: 'sync',
      },
      {
        from: 'SQL Copilot',
        to: 'Client',
        label: '400 when the payload carries a second statement after a semicolon',
        kind: 'reply',
      },
      {from: 'SQL Copilot', to: 'Read replica', label: 'SET TRANSACTION READ ONLY', kind: 'sync'},
      {from: 'SQL Copilot', to: 'Read replica', label: 'execute the statement · MAX_ROWS = 5000 cap', kind: 'sync'},
      {from: 'Read replica', to: 'SQL Copilot', label: 'rows', kind: 'reply'},
      {from: 'SQL Copilot', to: 'Client', label: '200 {rows, next_cursor}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/queries/{id}/results',
      detail: 'Register the results route on `GET /v1/queries/{id}/results`. (The draft already does.)',
      match: {
        python: {all: [/@app\.get\(\s*"\/v1\/queries\/\{query_id\}\/results"/]},
        typescript: {all: [/app\.get\(\s*'\/v1\/queries\/:queryId\/results'/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/queries\/\{queryId\}\/results"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"queries"\s*\/\s*Segment\s*\/\s*"results"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/queries\/\(\[\^\/\]\+\)\/results\)"/]},
      },
    },
    {
      id: 'server-side-statement',
      title: 'The statement comes from the server, never the request body',
      detail:
        'The statement is looked up by id from the record written when generation was validated (`store.get(query_id)`) and the page is addressed by a server-held `cursor`. The draft takes the SQL from the request body and runs it on the primary.',
      match: {
        python: {all: [/store\.get\(\s*query_id/, /cursor/], none: [/body\["statement"\]/]},
        typescript: {all: [/store\.get\(\s*queryId/, /cursor/], none: [/body\.statement/]},
        go: {all: [/store\.Statement\(/, /cursor/], none: [/body\.Statement/]},
        scala: {all: [/store\.get\(\s*queryId/, /cursor/], none: [/body\.statement/]},
        cpp: {all: [/store\.get\(\s*queryId/, /cursor/], none: [/body\[\s*"statement"\s*\]/]},
      },
    },
    {
      id: 'single-statement',
      title: 'Rejects a multi-statement payload',
      detail:
        'Anything with a second statement after a semicolon is rejected with **400** by `has_second_statement`, because a trailing `; DELETE …` is how a caller-supplied `LIMIT` gets removed. The draft hands whatever it is given to the database.',
      match: {
        python: {all: [/def has_second_statement\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/function hasSecondStatement\(/, /code\(\s*400\s*\)/]},
        go: {all: [/func hasSecondStatement\(/, /StatusBadRequest/]},
        scala: {all: [/def hasSecondStatement\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/hasSecondStatement\(/, /\b400\b/]},
      },
    },
    {
      id: 'row-cap',
      title: 'Caps the page at 5000 rows whatever the SQL asks for',
      detail:
        "`MAX_ROWS = 5000` is applied by the server (`rows[:MAX_ROWS]`, `slice(0, MAX_ROWS)`, `take(MaxRows)`) so a statement asking for more still returns at most 5000 rows. The draft returns whatever the caller's `LIMIT` asks for.",
      match: {
        python: {all: [/MAX_ROWS\s*=\s*5000/, /\[:MAX_ROWS\]/]},
        typescript: {all: [/MAX_ROWS\s*=\s*5000/, /slice\(0,\s*MAX_ROWS\)/]},
        go: {all: [/maxRows\s*=\s*5000/, /len\(\w+\)\s*>=\s*maxRows/]},
        scala: {all: [/MaxRows\s*=\s*5000/, /take\(MaxRows\)/]},
        cpp: {all: [/kMaxRows\s*=\s*5000/, /rows\.size\(\)\s*<\s*kMaxRows/]},
      },
    },
    {
      id: 'read-only',
      title: 'Runs inside a read-only transaction on the replica',
      detail:
        'The query executes on the read replica inside `SET TRANSACTION READ ONLY`, so the connection cannot write even if a mistake reaches it. The draft runs on the primary with no such transaction.',
      match: {
        python: {all: [/SET TRANSACTION READ ONLY/, /replica/]},
        typescript: {all: [/SET TRANSACTION READ ONLY/, /replica/]},
        go: {all: [/SET TRANSACTION READ ONLY/, /replica/]},
        scala: {all: [/SET TRANSACTION READ ONLY/, /replica/]},
        cpp: {all: [/SET TRANSACTION READ ONLY/, /replica/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("copilot")


class ResultsBody(BaseModel):
    statement: str
    limit: int = 100


class QueryStore:
    def get(self, query_id: str) -> dict | None:
        """The record written when generation was validated."""
        raise NotImplementedError


class Pool:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn

    async def fetch(self, sql: str) -> list[dict]:
        """Run a statement against this pool and return its rows."""
        raise NotImplementedError


store = QueryStore()
primary = Pool("postgres://primary/analytics")


@app.get("/v1/queries/{query_id}/results")
async def results(query_id: str, body: ResultsBody) -> JSONResponse:
    # TODO: this draft runs the statement the caller sent in the body on the primary, with the
    # caller's LIMIT and no row cap, no cursor and no read-only transaction. Review all of it.
    statement = body["statement"]
    rows = await primary.fetch(f"{statement} LIMIT {body.limit}")
    logger.info("results query_id=%s rows=%d", query_id, len(rows))
    return JSONResponse({"rows": rows}, status_code=200)
`,
      solution: `import base64
import logging

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("copilot")

MAX_ROWS = 5000


class QueryStore:
    def get(self, query_id: str) -> dict | None:
        """The record written when generation was validated: {"sql": ..., "read_only": True}."""
        raise NotImplementedError


class Connection:
    async def __aenter__(self) -> "Connection":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def execute(self, sql: str) -> None:
        """Run a statement that returns no rows (SET TRANSACTION READ ONLY)."""
        raise NotImplementedError

    async def fetch(self, sql: str) -> list[dict]:
        """Run a statement against this connection and return its rows."""
        raise NotImplementedError


class Pool:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn

    def acquire(self) -> Connection:
        """Borrow a connection from this pool."""
        return Connection()


store = QueryStore()
primary = Pool("postgres://primary/analytics")
replica = Pool("postgres://replica/analytics")


def has_second_statement(sql: str) -> bool:
    """True when the statement carries a second statement after a semicolon."""
    return ";" in sql.strip().rstrip(";")


def encode_cursor(offset: int) -> str:
    """The opaque page token the server issues; the client never builds one."""
    return base64.urlsafe_b64encode(f"row:{offset}".encode("utf-8")).decode("utf-8")


def decode_cursor(cursor: str | None) -> int:
    if cursor is None or cursor == "":
        return 0
    try:
        payload = base64.urlsafe_b64decode(cursor.encode("utf-8")).decode("utf-8")
        offset = int(payload.split(":", 1)[1])
    except (ValueError, IndexError):
        raise HTTPException(status_code=400, detail="invalid cursor")
    if offset < 0:
        raise HTTPException(status_code=400, detail="invalid cursor")
    return offset


@app.get("/v1/queries/{query_id}/results")
async def results(query_id: str, cursor: str | None = None) -> JSONResponse:
    record = store.get(query_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown query id")
    statement = record["sql"]
    if has_second_statement(statement):
        raise HTTPException(status_code=400, detail="a page may only run one statement")

    offset = decode_cursor(cursor)
    async with replica.acquire() as conn:
        await conn.execute("SET TRANSACTION READ ONLY")
        rows = await conn.fetch(statement)

    page = rows[offset:][:MAX_ROWS]
    logger.info("results query_id=%s rows=%d", query_id, len(page))
    return JSONResponse({"rows": page, "next_cursor": encode_cursor(offset + MAX_ROWS)}, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/queries/:queryId/results: a model-generated draft that runs the caller's SQL. */
import Fastify from 'fastify';

export const app = Fastify();

interface ResultsBody {
  statement: string;
  limit?: number;
}

export const store = {
  get: (queryId: string): {sql: string} | null => null,
};

export const primary = {
  query: async (sql: string): Promise<unknown[]> => [],
};

app.get('/v1/queries/:queryId/results', async (request, reply) => {
  // TODO: this draft runs the statement the caller sent in the body on the primary, with the
  // caller's LIMIT and no row cap, no cursor and no read-only transaction. Review all of it.
  const body = request.body as ResultsBody;
  const statement = body.statement;
  const rows = await primary.query(\`\${statement} LIMIT \${body.limit ?? 100}\`);
  request.log.info({queryId: (request.params as {queryId: string}).queryId, rows: rows.length}, 'results');
  return reply.code(200).send({rows});
});
`,
      solution: `/** GET /v1/queries/:queryId/results: the validated statement, capped and paged server-side. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_ROWS = 5000;

interface QueryRecord {
  sql: string;
}

interface Conn {
  execute(sql: string): Promise<void>;
  query(sql: string): Promise<unknown[]>;
  release(): void;
}

export const store = {
  get: (queryId: string): QueryRecord | null => null,
};

export const primary = {
  acquire: async (): Promise<Conn> => ({execute: async () => {}, query: async () => [], release: () => {}}),
};

export const replica = {
  acquire: async (): Promise<Conn> => ({execute: async () => {}, query: async () => [], release: () => {}}),
};

function hasSecondStatement(sql: string): boolean {
  return sql.trim().replace(/;\\s*$/, '').includes(';');
}

function encodeCursor(offset: number): string {
  return Buffer.from('row:' + offset, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === '') return 0;
  const payload = Buffer.from(cursor, 'base64url').toString('utf8');
  const offset = Number.parseInt(payload.slice(payload.indexOf(':') + 1), 10);
  if (!Number.isInteger(offset) || offset < 0) return null;
  return offset;
}

app.get('/v1/queries/:queryId/results', async (request, reply) => {
  const {queryId} = request.params as {queryId: string};
  const {cursor} = request.query as {cursor?: string};
  const record = store.get(queryId);
  if (record === null) return reply.code(404).send({error: 'unknown query id'});
  if (hasSecondStatement(record.sql))
    return reply.code(400).send({error: 'a page may only run one statement'});
  const offset = decodeCursor(cursor);
  if (offset === null) return reply.code(400).send({error: 'invalid cursor'});

  const conn = await replica.acquire();
  let all: unknown[];
  try {
    await conn.execute('SET TRANSACTION READ ONLY');
    all = await conn.query(record.sql);
  } finally {
    conn.release();
  }

  const remaining = all.slice(offset);
  const page = remaining.slice(0, MAX_ROWS);
  request.log.info({queryId, rows: page.length}, 'results');
  return reply.code(200).send({rows: page, next_cursor: encodeCursor(offset + MAX_ROWS)});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

type ResultsBody struct {
	Statement string \`json:"statement"\`
	Limit     int    \`json:"limit"\`
}

type Pool struct {
	dsn string
}

func (p *Pool) Fetch(ctx context.Context, sql string) ([][]any, error) {
	return nil, nil
}

var primary = &Pool{dsn: "postgres://primary/analytics"}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func results(rw http.ResponseWriter, r *http.Request) {
	queryID := r.PathValue("queryId")
	var body ResultsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft runs the statement the caller sent in the body on the primary, with the
	// caller's LIMIT and no row cap, no cursor and no read-only transaction. Review all of it.
	rows, err := primary.Fetch(r.Context(), fmt.Sprintf("%s LIMIT %d", body.Statement, body.Limit))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("results query_id=%s rows=%d", queryID, len(rows))
	writeJSON(rw, http.StatusOK, map[string]any{"rows": rows})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/queries/{queryId}/results", results)
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

const maxRows = 5000

type QueryStore struct{}

// Statement returns the SQL of the record written when generation was validated.
func (s *QueryStore) Statement(ctx context.Context, queryID string) (string, error) {
	return "", errors.New("no validated statement for " + queryID)
}

type Conn struct{}

func (c *Conn) Exec(ctx context.Context, sql string) error { return nil }

func (c *Conn) Query(ctx context.Context, sql string) ([][]any, error) { return nil, nil }

func (c *Conn) Release() {}

type Pool struct {
	dsn string
}

func (p *Pool) Acquire(ctx context.Context) (*Conn, error) {
	return &Conn{}, nil
}

var (
	store   = &QueryStore{}
	primary = &Pool{dsn: "postgres://primary/analytics"}
	replica = &Pool{dsn: "postgres://replica/analytics"}
)

func hasSecondStatement(sql string) bool {
	return strings.Contains(strings.TrimRight(strings.TrimSpace(sql), ";"), ";")
}

func encodeCursor(offset int) string {
	return base64.URLEncoding.EncodeToString([]byte("row:" + strconv.Itoa(offset)))
}

func decodeCursor(cursor string) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	raw, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimPrefix(string(raw), "row:"))
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func results(rw http.ResponseWriter, r *http.Request) {
	queryID := r.PathValue("queryId")
	statement, err := store.Statement(r.Context(), queryID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown query id"})
		return
	}
	if hasSecondStatement(statement) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "a page may only run one statement"})
		return
	}
	offset, err := decodeCursor(r.URL.Query().Get("cursor"))
	if err != nil || offset < 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid cursor"})
		return
	}

	conn, err := replica.Acquire(r.Context())
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	defer conn.Release()
	if err := conn.Exec(r.Context(), "SET TRANSACTION READ ONLY"); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	all, err := conn.Query(r.Context(), statement)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}

	page := make([][]any, 0, maxRows)
	skipped := 0
	for _, row := range all {
		if skipped < offset {
			skipped++
			continue
		}
		page = append(page, row)
		if len(page) >= maxRows {
			break
		}
	}
	log.Printf("results query_id=%s rows=%d", queryID, len(page))
	writeJSON(rw, http.StatusOK, map[string]any{
		"rows":        page,
		"next_cursor": encodeCursor(offset + maxRows),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/queries/{queryId}/results", results)
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
import spray.json.JsObject
import spray.json.RootJsonFormat

final case class ResultsRequest(statement: String, limit: Int)
final case class QueryRecord(query_id: String, sql: String)

final class QueryStore {
  def get(queryId: String): Option[QueryRecord] = None
}

final class Pool(name: String) {
  def fetch(sql: String): List[JsObject] = Nil
}

object SqlReadApi {
  implicit val system: ActorSystem = ActorSystem("sql-copilot")
  implicit val requestFormat: RootJsonFormat[ResultsRequest] = jsonFormat2(ResultsRequest)

  val store = new QueryStore
  val primary = new Pool("primary")

  val route: Route =
    path("v1" / "queries" / Segment / "results") { queryId =>
      get {
        entity(as[ResultsRequest]) { body =>
          // TODO: this draft runs the statement the caller sent in the body on the primary, with
          // the caller's LIMIT and no row cap, no cursor and no read-only transaction.
          val rows = primary.fetch(s"\${body.statement} LIMIT \${body.limit}")
          complete(StatusCodes.OK, s"""{"query_id":"$queryId","rows":\${rows.size}}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.JsObject
import spray.json.RootJsonFormat

import java.nio.charset.StandardCharsets
import java.util.Base64

final case class QueryRecord(query_id: String, sql: String)
final case class ResultPage(rows: List[JsObject], next_cursor: String)

final class QueryStore {
  def get(queryId: String): Option[QueryRecord] = None
}

final class Connection {
  def execute(sql: String): Unit = ()
  def fetch(sql: String): List[JsObject] = Nil
}

final class Pool(name: String) {
  def acquire(): Connection = new Connection
  def release(conn: Connection): Unit = ()
}

object SqlReadApi {
  implicit val system: ActorSystem = ActorSystem("sql-copilot")
  implicit val pageFormat: RootJsonFormat[ResultPage] = jsonFormat2(ResultPage)

  val MaxRows = 5000

  val store = new QueryStore
  val primary = new Pool("primary")
  val replica = new Pool("replica")

  def hasSecondStatement(sql: String): Boolean =
    sql.trim.stripSuffix(";").contains(";")

  def encodeCursor(offset: Int): String =
    Base64.getUrlEncoder.encodeToString(s"row:$offset".getBytes(StandardCharsets.UTF_8))

  def decodeCursor(cursor: Option[String]): Option[Int] =
    cursor match {
      case None | Some("") => Some(0)
      case Some(value) =>
        try {
          val payload = new String(Base64.getUrlDecoder.decode(value), StandardCharsets.UTF_8)
          val offset = payload.split(":", 2)(1).toInt
          if (offset < 0) None else Some(offset)
        } catch {
          case _: IllegalArgumentException => None
        }
    }

  val route: Route =
    path("v1" / "queries" / Segment / "results") { queryId =>
      get {
        parameter("cursor".?) { cursorOpt =>
          store.get(queryId) match {
            case None =>
              complete(StatusCodes.NotFound, """{"error":"unknown query id"}""")
            case Some(record) if hasSecondStatement(record.sql) =>
              complete(StatusCodes.BadRequest, """{"error":"a page may only run one statement"}""")
            case Some(record) =>
              decodeCursor(cursorOpt) match {
                case None =>
                  complete(StatusCodes.BadRequest, """{"error":"invalid cursor"}""")
                case Some(offset) =>
                  val conn = replica.acquire()
                  val page =
                    try {
                      conn.execute("SET TRANSACTION READ ONLY")
                      conn.fetch(record.sql).drop(offset).take(MaxRows)
                    } finally conn.release()
                  complete(StatusCodes.OK, ResultPage(page, encodeCursor(offset + MaxRows)))
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

#include <iostream>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

struct QueryStore {
  std::optional<json> get(const std::string& queryId);
};

struct Pool {
  std::string dsn;
  std::vector<json> query(const std::string& sql);
};

QueryStore store;
Pool primary{"postgres://primary/analytics"};

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/queries/([^/]+)/results)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string queryId = req.matches[1];
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft runs the statement the caller sent in the body on the primary, with the
    // caller's LIMIT and no row cap, no cursor and no read-only transaction. Review all of it.
    const auto statement = body["statement"].get<std::string>();
    const auto limit = body.value("limit", 100);
    const auto rows = primary.query(statement + " LIMIT " + std::to_string(limit));
    std::cerr << "results query_id=" << queryId << " rows=" << rows.size() << "\\n";
    res.status = 200;
    res.set_content(json{{"rows", rows}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxRows = 5000;

struct QueryStore {
  std::optional<json> get(const std::string& queryId);
};

struct ResultSet {
  bool next();
  json row() const;
};

struct Connection {
  void execute(const std::string& sql);
  ResultSet query(const std::string& sql);
};

struct Pool {
  std::string dsn;
  Connection acquire();
  void release(Connection& conn);
};

QueryStore store;
Pool primary{"postgres://primary/analytics"};
Pool replica{"postgres://replica/analytics"};
std::string encodeCursor(int offset);
int decodeCursor(const std::string& cursor);

bool hasSecondStatement(const std::string& sql) {
  std::string trimmed = sql;
  while (!trimmed.empty() && (trimmed.back() == ';' || trimmed.back() == ' ')) trimmed.pop_back();
  return trimmed.find(';') != std::string::npos;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/queries/([^/]+)/results)", [](const httplib::Request& req, httplib::Response& resp) {
    const std::string queryId = req.matches[1];
    const auto cursor = req.get_param_value("cursor");
    const auto record = store.get(queryId);
    if (!record) {
      resp.status = 404;
      resp.set_content(R"({"error":"unknown query id"})", "application/json");
      return;
    }
    const auto statement = record->at("sql").get<std::string>();
    if (hasSecondStatement(statement)) {
      resp.status = 400;
      resp.set_content(R"({"error":"a page may only run one statement"})", "application/json");
      return;
    }
    const int offset = decodeCursor(cursor);
    if (offset < 0) {
      resp.status = 400;
      resp.set_content(R"({"error":"invalid cursor"})", "application/json");
      return;
    }

    auto conn = replica.acquire();
    conn.execute("SET TRANSACTION READ ONLY");
    auto res = conn.query(statement);
    json rows = json::array();
    int skipped = 0;
    while (res.next() && rows.size() < kMaxRows) {
      if (skipped < offset) {
        ++skipped;
        continue;
      }
      rows.push_back(res.row());
    }
    replica.release(conn);

    std::cerr << "results query_id=" << queryId << " rows=" << rows.size() << "\\n";
    resp.status = 200;
    resp.set_content(json{{"rows", rows}, {"next_cursor", encodeCursor(offset + kMaxRows)}}.dump(),
                     "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The statement is not part of this request: look it up by id from the record written when generation was validated, so the endpoint can only ever run SQL the copilot already dry-ran and marked read-only.',
    'One statement, capped rows: reject anything carrying a second statement after a semicolon — that is how a caller-supplied `LIMIT` gets removed — then apply the 5000-row cap server-side, never whatever `LIMIT` the SQL asks for.',
    'Open the transaction read-only (`SET TRANSACTION READ ONLY`) on the replica so even a mistake cannot write, and page with a server-held cursor (an opaque offset you issue) rather than a caller-supplied `LIMIT` or `OFFSET`.',
  ],
  debrief: `The interviewer is testing the boundary between "the caller names a query" and "the caller names SQL". Once the statement comes from the validated record and the page address comes from a server-held cursor, the endpoint can only ever run SQL the copilot already dry-ran and marked read-only; the single-statement guard stops a trailing \`; DELETE …\` from turning a page read into a write, the cap stops one page from becoming a full-table export, and \`SET TRANSACTION READ ONLY\` on the replica means a mistake cannot write even if it reaches a connection. Real systems add row-level permissions enforced down in the warehouse, a signed (not merely opaque) cursor so it cannot be forged, cost limits derived from the plan before execution, and a separate write path that is never reachable from the copilot.`,
};
