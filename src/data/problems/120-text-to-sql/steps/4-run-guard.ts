import type {Step} from '@/lib/types';

export const runGuardStep: Step = {
  id: 'run-guard',
  title: 'POST /v1/queries/{id}/run: generated SQL never runs as-is',
  concept: 'http',
  file: 'run_api',
  focus: ['analyst', 'api', 'warehouse'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it looks the query up and
hands its SQL to the warehouse. With well-behaved model output the demo passes. It hides four
production flaws: anything the model wrote is executed, against any table, without a partition
filter, with no row cap and no timeout. Review it like the owner of the warehouse, fix it, and prove
the fix.

Implement \`POST /v1/queries/{id}/run\`. The record for \`{id}\` holds \`sql\`, \`user\`,
\`workspace\` and \`tables_acked\` (the list the user confirmed or edited). **401** without
\`X-User-Id\`, **404** for an unknown id, **403** when the record belongs to another user. Before
the warehouse sees a byte, the guard checks:

- **One SELECT.** \`is_single_select\`: the statement starts with \`SELECT\` or \`WITH\` and contains
  no second statement (no \`;\` inside). Anything else is **422** — the generator is asked for a
  query, and "a query" is never an \`INSERT\`, a \`DROP\` or two statements.
- **ACKed tables only.** \`referenced_tables\` collects every \`FROM\`/\`JOIN\` target; a table
  outside \`tables_acked\` is **422**. The source names tables that do not exist as the
  hallucination it still fights; the ACKed list is the one set of names the service can vouch for.
- **A partition filter.** Warehouse tables are partitioned by \`datestr\`
  (\`PARTITION_COLUMN\`); a \`WHERE\` without it is **422**, because the source's own evaluation
  shows generated queries failing for exactly this reason, and the ones that do not fail scan
  every partition.
- **A row cap.** \`with_limit\` appends \`LIMIT 1000\` (\`MAX_ROWS\`) when the query has none and
  lowers a larger one. **A statement timeout** of **60 s** (\`STATEMENT_TIMEOUT_S\`) is passed to
  the warehouse call.

The response reports \`row_count\` and \`has_output\` — the signal the source tracks separately from
"ran successfully", because a hallucinated filter like \`status = 'Finished'\` runs fine and
returns nothing.

**Failure mode the checks target.** Executing model output verbatim means the model, not the
service, decides what the warehouse runs: one hallucinated table name is a failed query, one
missing partition filter is a full-table scan, one missing \`LIMIT\` streams a billion rows into a
browser tab, and one slow join holds a warehouse slot until someone notices. The draft gets all of
these wrong by doing nothing at all.`,
  sequence: {
    participants: ['Analyst', 'querygen', 'query store', 'Warehouse'],
    messages: [
      {from: 'Analyst', to: 'querygen', label: 'POST /v1/queries/{id}/run · X-User-Id', kind: 'sync'},
      {from: 'querygen', to: 'query store', label: 'get_query(id)', kind: 'sync'},
      {from: 'query store', to: 'querygen', label: '{sql, user, tables_acked} / none → 404', kind: 'reply'},
      {from: 'querygen', to: 'querygen', label: 'single SELECT · tables ⊆ acked · datestr filter → 422', kind: 'sync'},
      {from: 'querygen', to: 'Warehouse', label: 'execute(sql + LIMIT 1000, timeout 60 s)', kind: 'sync'},
      {from: 'Warehouse', to: 'querygen', label: 'rows', kind: 'reply'},
      {from: 'querygen', to: 'Analyst', label: '200 {row_count, has_output, rows}', kind: 'reply'},
    ],
  },
  hints: [
    'The guard is four pure functions over the SQL string and one lookup: `is_single_select`, `referenced_tables`, `has_partition_filter`, `with_limit`. Write them first, test them in your head on `SELECT … ; DROP TABLE …`, then wire the handler to answer 422 at the first one that fails.',
    'Table references are the identifiers after `FROM` and `JOIN` (case-insensitive, dotted names allowed). Lower-case both sides and take the set difference against `tables_acked`; the difference is the 422 message, so the user sees which name the model invented.',
    'The partition check is a `WHERE` followed somewhere by `datestr`; the limit is a regex on a trailing `LIMIT n`: append when absent, replace when larger than `MAX_ROWS`. Pass `timeout_s=STATEMENT_TIMEOUT_S` to the warehouse call — the limit bounds the rows, the timeout bounds the time.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/queries/{id}/run',
      detail: 'Register the run route on `POST /v1/queries/{id}/run`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/queries\/\{query_id\}\/run["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/queries\/:id\/run['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/queries\/\{id\}\/run"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"queries"\s*\/\s*Segment\s*\/\s*"run"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*R"\(\/v1\/queries\/\(\[\^\/\]\+\)\/run\)"/]},
      },
    },
    {
      id: 'single-select',
      title: 'Runs only a single SELECT',
      detail:
        '`is_single_select` accepts one statement starting with `SELECT` or `WITH` and nothing else; a failure is **422**. The draft executes whatever the model wrote.',
      match: {
        python: {all: [/def is_single_select\(/, /status_code\s*=\s*422/]},
        typescript: {all: [/function isSingleSelect\(/, /code\(\s*422\s*\)/]},
        go: {all: [/func isSingleSelect\(/, /StatusUnprocessableEntity/]},
        scala: {all: [/def isSingleSelect\(/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/isSingleSelect\(/, /status\s*=\s*422/]},
      },
    },
    {
      id: 'tables-acked',
      title: 'Rejects tables outside the ACKed list',
      detail:
        '`referenced_tables` collects every `FROM`/`JOIN` target and any name not in `tables_acked` is **422**. The draft lets a hallucinated table reach the warehouse.',
      match: {
        python: {all: [/def referenced_tables\(/, /tables_acked/, /status_code\s*=\s*422/]},
        typescript: {all: [/function referencedTables\(/, /tables_acked/, /code\(\s*422\s*\)/]},
        go: {all: [/func referencedTables\(/, /TablesAcked/, /StatusUnprocessableEntity/]},
        scala: {all: [/def referencedTables\(/, /tablesAcked/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/referencedTables\(/, /tables_acked/, /status\s*=\s*422/]},
      },
    },
    {
      id: 'partition-filter',
      title: 'Requires a filter on the partition column',
      detail:
        '`has_partition_filter` requires `datestr` (`PARTITION_COLUMN`) in the `WHERE` clause; a query without one is **422** instead of a full scan.',
      match: {
        python: {all: [/PARTITION_COLUMN\s*=\s*["']datestr["']/, /def has_partition_filter\(/]},
        typescript: {all: [/PARTITION_COLUMN\s*=\s*['"]datestr['"]/, /function hasPartitionFilter\(/]},
        go: {all: [/partitionColumn\s*=\s*"datestr"/, /func hasPartitionFilter\(/]},
        scala: {all: [/PartitionColumn\s*=\s*"datestr"/, /def hasPartitionFilter\(/]},
        cpp: {all: [/kPartitionColumn\s*=\s*"datestr"/, /hasPartitionFilter\(/]},
      },
    },
    {
      id: 'limit-timeout',
      title: 'Injects LIMIT 1000 and a 60 s statement timeout',
      detail:
        '`with_limit` appends `LIMIT 1000` (`MAX_ROWS`) or lowers a larger one, and the warehouse call carries `STATEMENT_TIMEOUT_S = 60`. The draft runs the query unbounded in rows and time.',
      match: {
        python: {
          all: [
            /MAX_ROWS\s*=\s*1000/,
            /STATEMENT_TIMEOUT_S\s*=\s*60/,
            /def with_limit\(/,
            /timeout_s=STATEMENT_TIMEOUT_S/,
          ],
        },
        typescript: {
          all: [
            /MAX_ROWS\s*=\s*1000/,
            /STATEMENT_TIMEOUT_S\s*=\s*60/,
            /function withLimit\(/,
            /timeoutS:\s*STATEMENT_TIMEOUT_S/,
          ],
        },
        go: {
          all: [
            /maxRows\s*=\s*1000/,
            /statementTimeout\s*=\s*60\s*\*\s*time\.Second/,
            /func withLimit\(/,
            /context\.WithTimeout\([^;]*statementTimeout\)/,
          ],
        },
        scala: {
          all: [
            /MaxRows\s*=\s*1000/,
            /StatementTimeoutS\s*=\s*60/,
            /def withLimit\(/,
            /execute\([^;]*StatementTimeoutS/,
          ],
        },
        cpp: {
          all: [
            /kMaxRows\s*=\s*1000/,
            /kStatementTimeoutS\s*=\s*60/,
            /withLimit\(/,
            /execute\([^;]*kStatementTimeoutS/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header, HTTPException

from query_store import store
from warehouse import warehouse

app = FastAPI()


@app.post("/v1/queries/{query_id}/run")
def run_query(query_id: str, user: str = Header(alias="X-User-Id")) -> dict:
    # TODO: the generated SQL is executed as-is: no single-SELECT check, no check that the tables
    # are the ACKed ones, no partition filter required, no LIMIT, no statement timeout.
    record = store.get_query(query_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown query")
    rows = warehouse.execute(record["sql"])
    return {"query_id": query_id, "user": user, "rows": rows, "row_count": len(rows)}
`,
      solution: `import re

from fastapi import FastAPI, Header, HTTPException

from query_store import store
from warehouse import warehouse

app = FastAPI()

MAX_ROWS = 1000
STATEMENT_TIMEOUT_S = 60
PARTITION_COLUMN = "datestr"

TABLE_REF = re.compile(r"\\b(?:from|join)\\s+([a-z_][\\w.]*)", re.IGNORECASE)
TRAILING_LIMIT = re.compile(r"\\blimit\\s+(\\d+)\\s*$", re.IGNORECASE)


def strip_statement(sql: str) -> str:
    return sql.strip().rstrip(";").strip()


def is_single_select(sql: str) -> bool:
    body = strip_statement(sql)
    if ";" in body:
        return False
    return re.match(r"^(select|with)\\b", body, re.IGNORECASE) is not None


def referenced_tables(sql: str) -> set[str]:
    return {name.lower() for name in TABLE_REF.findall(sql)}


def has_partition_filter(sql: str) -> bool:
    pattern = rf"\\bwhere\\b[\\s\\S]*\\b{PARTITION_COLUMN}\\b"
    return re.search(pattern, sql, re.IGNORECASE) is not None


def with_limit(sql: str) -> str:
    body = strip_statement(sql)
    found = TRAILING_LIMIT.search(body)
    if found is None:
        return f"{body} LIMIT {MAX_ROWS}"
    if int(found.group(1)) > MAX_ROWS:
        return f"{body[: found.start()]}LIMIT {MAX_ROWS}"
    return body


@app.post("/v1/queries/{query_id}/run")
def run_query(query_id: str, user: str | None = Header(default=None, alias="X-User-Id")) -> dict:
    if user is None or user == "":
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    record = store.get_query(query_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown query")
    if record["user"] != user:
        raise HTTPException(status_code=403, detail="not your query")

    sql = record["sql"]
    if not is_single_select(sql):
        raise HTTPException(status_code=422, detail="only a single SELECT may run")
    acked = {name.lower() for name in record["tables_acked"]}
    extra = referenced_tables(sql) - acked
    if extra:
        raise HTTPException(status_code=422, detail=f"tables not ACKed: {sorted(extra)}")
    if not has_partition_filter(sql):
        raise HTTPException(status_code=422, detail=f"query must filter on {PARTITION_COLUMN}")

    rows = warehouse.execute(with_limit(sql), timeout_s=STATEMENT_TIMEOUT_S)
    return {"query_id": query_id, "rows": rows, "row_count": len(rows), "has_output": len(rows) > 0}
`,
    },
    typescript: {
      starter: `/** POST /v1/queries/:id/run: a model-generated draft that executes the generated SQL as-is. */
import Fastify from 'fastify';

import {store} from './store';
import {warehouse} from './warehouse';

export const app = Fastify();

app.post('/v1/queries/:id/run', async (request, reply) => {
  // TODO: the generated SQL is executed as-is: no single-SELECT check, no check that the tables
  // are the ACKed ones, no partition filter required, no LIMIT, no statement timeout.
  const user = request.headers['x-user-id'] as string;
  const {id} = request.params as {id: string};
  const record = await store.getQuery(id);
  if (record === null) return reply.code(404).send({error: 'unknown query'});
  const rows = await warehouse.execute(record.sql);
  return reply.code(200).send({query_id: id, user, rows, row_count: rows.length});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/queries/:id/run: one SELECT over ACKed tables with a partition filter, capped and timed. */
import Fastify from 'fastify';

import {store} from './store';
import {warehouse} from './warehouse';

export const app = Fastify();

const MAX_ROWS = 1000;
const STATEMENT_TIMEOUT_S = 60;
const PARTITION_COLUMN = 'datestr';

const TABLE_REF = /\\b(?:from|join)\\s+([a-z_][\\w.]*)/gi;
const TRAILING_LIMIT = /\\blimit\\s+(\\d+)\\s*$/i;

function stripStatement(sql: string): string {
  return sql.trim().replace(/;\\s*$/, '').trim();
}

function isSingleSelect(sql: string): boolean {
  const body = stripStatement(sql);
  if (body.includes(';')) return false;
  return /^(select|with)\\b/i.test(body);
}

function referencedTables(sql: string): Set<string> {
  const names = new Set<string>();
  for (const match of sql.matchAll(TABLE_REF)) names.add(match[1].toLowerCase());
  return names;
}

function hasPartitionFilter(sql: string): boolean {
  return new RegExp(\`\\\\bwhere\\\\b[\\\\s\\\\S]*\\\\b\${PARTITION_COLUMN}\\\\b\`, 'i').test(sql);
}

function withLimit(sql: string): string {
  const body = stripStatement(sql);
  const found = TRAILING_LIMIT.exec(body);
  if (found === null) return \`\${body} LIMIT \${MAX_ROWS}\`;
  if (Number(found[1]) > MAX_ROWS) return \`\${body.slice(0, found.index)}LIMIT \${MAX_ROWS}\`;
  return body;
}

app.post('/v1/queries/:id/run', async (request, reply) => {
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const {id} = request.params as {id: string};
  const record = await store.getQuery(id);
  if (record === null) return reply.code(404).send({error: 'unknown query'});
  if (record.user !== user) return reply.code(403).send({error: 'not your query'});

  const sql = record.sql;
  if (!isSingleSelect(sql)) return reply.code(422).send({error: 'only a single SELECT may run'});
  const acked = new Set(record.tables_acked.map(name => name.toLowerCase()));
  const extra = [...referencedTables(sql)].filter(name => !acked.has(name));
  if (extra.length > 0) return reply.code(422).send({error: \`tables not ACKed: \${extra.join(', ')}\`});
  if (!hasPartitionFilter(sql)) return reply.code(422).send({error: \`query must filter on \${PARTITION_COLUMN}\`});

  const rows = await warehouse.execute(withLimit(sql), {timeoutS: STATEMENT_TIMEOUT_S});
  return reply.code(200).send({query_id: id, rows, row_count: rows.length, has_output: rows.length > 0});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"querygen/store"
	"querygen/warehouse"
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func runQuery(rw http.ResponseWriter, r *http.Request) {
	// TODO: the generated SQL is executed as-is: no single-SELECT check, no check that the tables
	// are the ACKed ones, no partition filter required, no LIMIT, no statement timeout.
	user := r.Header.Get("X-User-Id")
	id := r.PathValue("id")
	record, err := store.GetQuery(r.Context(), id)
	if err != nil || record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown query"})
		return
	}
	rows, err := warehouse.Execute(r.Context(), record.SQL)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"query_id": id, "user": user, "rows": rows, "row_count": len(rows)})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/queries/{id}/run", runQuery)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"querygen/store"
	"querygen/warehouse"
)

const (
	maxRows          = 1000
	statementTimeout = 60 * time.Second
	partitionColumn  = "datestr"
)

var (
	tableRef      = regexp.MustCompile(\`(?i)\\b(?:from|join)\\s+([a-z_][\\w.]*)\`)
	trailingLimit = regexp.MustCompile(\`(?i)\\blimit\\s+(\\d+)\\s*$\`)
	selectStart   = regexp.MustCompile(\`(?i)^(select|with)\\b\`)
	partitionRef  = regexp.MustCompile(\`(?is)\\bwhere\\b.*\\b\` + partitionColumn + \`\\b\`)
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func stripStatement(sql string) string {
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(sql), ";"))
}

func isSingleSelect(sql string) bool {
	body := stripStatement(sql)
	if strings.Contains(body, ";") {
		return false
	}
	return selectStart.MatchString(body)
}

func referencedTables(sql string) map[string]bool {
	names := map[string]bool{}
	for _, match := range tableRef.FindAllStringSubmatch(sql, -1) {
		names[strings.ToLower(match[1])] = true
	}
	return names
}

func hasPartitionFilter(sql string) bool {
	return partitionRef.MatchString(sql)
}

func withLimit(sql string) string {
	body := stripStatement(sql)
	loc := trailingLimit.FindStringSubmatchIndex(body)
	if loc == nil {
		return fmt.Sprintf("%s LIMIT %d", body, maxRows)
	}
	if n, _ := strconv.Atoi(body[loc[2]:loc[3]]); n > maxRows {
		return fmt.Sprintf("%sLIMIT %d", body[:loc[0]], maxRows)
	}
	return body
}

func runQuery(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	if user == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	id := r.PathValue("id")
	record, err := store.GetQuery(r.Context(), id)
	if err != nil || record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown query"})
		return
	}
	if record.User != user {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "not your query"})
		return
	}
	sql := record.SQL
	if !isSingleSelect(sql) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "only a single SELECT may run"})
		return
	}
	acked := map[string]bool{}
	for _, name := range record.TablesAcked {
		acked[strings.ToLower(name)] = true
	}
	var extra []string
	for name := range referencedTables(sql) {
		if !acked[name] {
			extra = append(extra, name)
		}
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "tables not ACKed: " + strings.Join(extra, ", ")})
		return
	}
	if !hasPartitionFilter(sql) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "query must filter on " + partitionColumn})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), statementTimeout)
	defer cancel()
	rows, err := warehouse.Execute(ctx, withLimit(sql))
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"query_id": id, "rows": rows, "row_count": len(rows), "has_output": len(rows) > 0})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/queries/{id}/run", runQuery)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object RunApi {
  implicit val system: ActorSystem = ActorSystem("querygen")

  val store = QueryStore.open()
  val warehouse = Warehouse.connect()

  val route: Route =
    path("v1" / "queries" / Segment / "run") { queryId =>
      post {
        headerValueByName("X-User-Id") { user =>
          // TODO: the generated SQL is executed as-is: no single-SELECT check, no check that the
          // tables are the ACKed ones, no partition filter required, no LIMIT, no statement timeout.
          store.getQuery(queryId) match {
            case None =>
              complete(StatusCodes.NotFound, """{"error":"unknown query"}""")
            case Some(record) =>
              val rows = warehouse.execute(record.sql)
              complete(StatusCodes.OK, s"""{"query_id":"$queryId","user":"$user","row_count":\${rows.size}}""")
          }
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object RunApi {
  implicit val system: ActorSystem = ActorSystem("querygen")

  val MaxRows = 1000
  val StatementTimeoutS = 60
  val PartitionColumn = "datestr"

  val TableRef = """(?i)\\b(?:from|join)\\s+([a-z_][\\w.]*)""".r
  val TrailingLimit = """(?i)\\blimit\\s+(\\d+)\\s*$""".r
  val SelectStart = """(?i)^(select|with)\\b""".r
  val PartitionRef = s"""(?is)\\\\bwhere\\\\b.*\\\\b$PartitionColumn\\\\b""".r

  val store = QueryStore.open()
  val warehouse = Warehouse.connect()

  def stripStatement(sql: String): String = sql.trim.stripSuffix(";").trim

  def isSingleSelect(sql: String): Boolean = {
    val body = stripStatement(sql)
    !body.contains(";") && SelectStart.findFirstIn(body).isDefined
  }

  def referencedTables(sql: String): Set[String] =
    TableRef.findAllMatchIn(sql).map(_.group(1).toLowerCase).toSet

  def hasPartitionFilter(sql: String): Boolean = PartitionRef.findFirstIn(sql).isDefined

  def withLimit(sql: String): String = {
    val body = stripStatement(sql)
    TrailingLimit.findFirstMatchIn(body) match {
      case None => s"$body LIMIT $MaxRows"
      case Some(m) if m.group(1).toInt > MaxRows => s"\${body.substring(0, m.start)}LIMIT $MaxRows"
      case Some(_) => body
    }
  }

  val route: Route =
    path("v1" / "queries" / Segment / "run") { queryId =>
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          if (!userOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-User-Id"}""")
          } else {
            val user = userOpt.get
            store.getQuery(queryId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown query"}""")
              case Some(record) if record.user != user =>
                complete(StatusCodes.Forbidden, """{"error":"not your query"}""")
              case Some(record) =>
                val sql = record.sql
                val acked = record.tablesAcked.map(_.toLowerCase).toSet
                val extra = (referencedTables(sql) -- acked).toSeq.sorted
                if (!isSingleSelect(sql)) {
                  complete(StatusCodes.UnprocessableEntity, """{"error":"only a single SELECT may run"}""")
                } else if (extra.nonEmpty) {
                  complete(StatusCodes.UnprocessableEntity, s"""{"error":"tables not ACKed: \${extra.mkString(", ")}"}""")
                } else if (!hasPartitionFilter(sql)) {
                  complete(StatusCodes.UnprocessableEntity, s"""{"error":"query must filter on $PartitionColumn"}""")
                } else {
                  val rows = warehouse.execute(withLimit(sql), StatementTimeoutS)
                  complete(
                    StatusCodes.OK,
                    s"""{"query_id":"$queryId","row_count":\${rows.size},"has_output":\${rows.nonEmpty}}"""
                  )
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

#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

struct QueryStore {
  std::optional<json> getQuery(const std::string& queryId);
};

struct Warehouse {
  std::vector<json> execute(const std::string& sql);
};

QueryStore store;
Warehouse warehouse;

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/v1/queries/([^/]+)/run)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: the generated SQL is executed as-is: no single-SELECT check, no check that the tables
    // are the ACKed ones, no partition filter required, no LIMIT, no statement timeout.
    const auto user = req.get_header_value("X-User-Id");
    const auto queryId = req.matches[1].str();
    const auto record = store.getQuery(queryId);
    if (!record) {
      res.status = 404;
      res.set_content(R"({"error":"unknown query"})", "application/json");
      return;
    }
    const auto rows = warehouse.execute((*record)["sql"].get<std::string>());
    res.status = 200;
    res.set_content(json{{"query_id", queryId}, {"user", user}, {"rows", rows}, {"row_count", rows.size()}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <optional>
#include <regex>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxRows = 1000;
constexpr int kStatementTimeoutS = 60;
const std::string kPartitionColumn = "datestr";

const std::regex kTableRef(R"(\\b(?:from|join)\\s+([a-z_][\\w.]*))", std::regex::icase);
const std::regex kTrailingLimit(R"(\\blimit\\s+(\\d+)\\s*$)", std::regex::icase);
const std::regex kSelectStart(R"(^(select|with)\\b)", std::regex::icase);
const std::regex kPartitionRef("\\\\bwhere\\\\b[\\\\s\\\\S]*\\\\b" + kPartitionColumn + "\\\\b", std::regex::icase);

struct QueryStore {
  std::optional<json> getQuery(const std::string& queryId);
};

struct Warehouse {
  std::vector<json> execute(const std::string& sql, int timeoutS);
};

QueryStore store;
Warehouse warehouse;

std::string stripStatement(const std::string& sql) {
  auto body = sql;
  const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
  body.erase(body.begin(), std::find_if(body.begin(), body.end(), notSpace));
  body.erase(std::find_if(body.rbegin(), body.rend(), notSpace).base(), body.end());
  if (!body.empty() && body.back() == ';') body.pop_back();
  body.erase(std::find_if(body.rbegin(), body.rend(), notSpace).base(), body.end());
  return body;
}

bool isSingleSelect(const std::string& sql) {
  const auto body = stripStatement(sql);
  if (body.find(';') != std::string::npos) return false;
  return std::regex_search(body, kSelectStart);
}

std::set<std::string> referencedTables(const std::string& sql) {
  std::set<std::string> names;
  for (auto it = std::sregex_iterator(sql.begin(), sql.end(), kTableRef); it != std::sregex_iterator(); ++it) {
    auto name = (*it)[1].str();
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return std::tolower(c); });
    names.insert(name);
  }
  return names;
}

bool hasPartitionFilter(const std::string& sql) { return std::regex_search(sql, kPartitionRef); }

std::string withLimit(const std::string& sql) {
  const auto body = stripStatement(sql);
  std::smatch found;
  if (!std::regex_search(body, found, kTrailingLimit)) return body + " LIMIT " + std::to_string(kMaxRows);
  if (std::stoull(found[1].str()) > kMaxRows)
    return body.substr(0, static_cast<std::size_t>(found.position(0))) + "LIMIT " + std::to_string(kMaxRows);
  return body;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/v1/queries/([^/]+)/run)", [](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    if (user.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-User-Id"})", "application/json");
      return;
    }
    const auto queryId = req.matches[1].str();
    const auto record = store.getQuery(queryId);
    if (!record) {
      res.status = 404;
      res.set_content(R"({"error":"unknown query"})", "application/json");
      return;
    }
    if ((*record)["user"].get<std::string>() != user) {
      res.status = 403;
      res.set_content(R"({"error":"not your query"})", "application/json");
      return;
    }
    const auto sql = (*record)["sql"].get<std::string>();
    if (!isSingleSelect(sql)) {
      res.status = 422;
      res.set_content(R"({"error":"only a single SELECT may run"})", "application/json");
      return;
    }
    std::set<std::string> acked;
    for (const auto& name : (*record)["tables_acked"]) {
      auto lowered = name.get<std::string>();
      std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char c) { return std::tolower(c); });
      acked.insert(lowered);
    }
    std::vector<std::string> extra;
    for (const auto& name : referencedTables(sql)) {
      if (acked.count(name) == 0) extra.push_back(name);
    }
    if (!extra.empty()) {
      res.status = 422;
      res.set_content(json{{"error", "tables not ACKed"}, {"tables", extra}}.dump(), "application/json");
      return;
    }
    if (!hasPartitionFilter(sql)) {
      res.status = 422;
      res.set_content(json{{"error", "query must filter on " + kPartitionColumn}}.dump(), "application/json");
      return;
    }
    const auto rows = warehouse.execute(withLimit(sql), kStatementTimeoutS);
    res.status = 200;
    res.set_content(
        json{{"query_id", queryId}, {"rows", rows}, {"row_count", rows.size()}, {"has_output", !rows.empty()}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you treat model output as input. Generated SQL is a string from an untrusted source that happens to look like code, and the run endpoint is the boundary where it becomes real work on a shared warehouse. Four separate guards are being checked, each cheap and each closing a specific hole: statement shape (one SELECT, so the generator can never be talked into a write), table provenance (the ACKed list is the only set of names the service vouches for — the source's hallucinated tables cannot pass it), partition hygiene (the source's own evaluation dashboard shows queries failing for a missing partition filter; the ones that do not fail are worse), and bounds (\`LIMIT\` for rows, a timeout for time). \`has_output\` in the response is the fifth lesson, lifted from the evaluation section: a query that runs and returns nothing is the signature of a hallucinated filter value, and a service that only tracks "ran OK" cannot see it. Real services add a proper SQL parser instead of regexes, a dry-run \`EXPLAIN\` with a cost ceiling, per-user warehouse queues, and a validation agent that repairs unknown columns before the user ever sees the query.`,
};
