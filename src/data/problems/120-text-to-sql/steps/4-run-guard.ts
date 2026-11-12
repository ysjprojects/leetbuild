import type {Step} from '@/lib/types';

export const runGuardStep: Step = {
  id: 'run-guard',
  title: 'POST /v1/queries/{id}/run: a guard between generated SQL and the warehouse',
  concept: 'http',
  guides: ['request-boundaries', 'honest-reads'],
  file: 'run_api',
  focus: ['analyst', 'api', 'warehouse'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/queries/{query_id}/run\`: 401 without \`X-User-Id\`, 404
for an unknown id, 403 for another user's record; then it sends the record's \`sql\` as written to
\`Warehouse.Execute\` (a stand-in at \`WAREHOUSE\`), saves \`status: "ran"\` and \`run_ok\` with
\`store.save\`, and answers \`{query_id, run_ok, row_count, columns, rows}\`. It serves the demo and hides
5 flaws.

**Failure mode the checks target.** The model decides what the warehouse runs: a second statement or
a \`DELETE\`, a table nobody ACKed, a scan of every \`datestr\` partition, a million rows into a browser
tab, a join that holds a slot for an hour. And a hallucinated filter such as \`status = 'Finished'\` runs
cleanly and returns nothing, which the record cannot tell from success.

Requirements, all before the warehouse sees a byte (**422** otherwise):

- \`is_single_select\`: one statement (a trailing \`;\` is fine) starting with \`SELECT\` or \`WITH\`.
- \`referenced_tables\`: every \`FROM\`/\`JOIN\` target, case-insensitive, is in \`tables_acked\`.
- \`has_partition_filter\`: the \`WHERE\` clause names \`PARTITION_COLUMN\` (\`datestr\`).
- \`with_limit\` caps the statement at \`MAX_ROWS\` = 1000 (appended, or a larger \`LIMIT\` lowered); the
  call carries \`STATEMENT_TIMEOUT_S\` = 60 and a timeout answers **504**.
- \`has_output\` (any rows) is in the answer and saved on the record with \`run_ok\`.`,
  sequence: {
    participants: ['Analyst', 'querygen', 'query store', 'Warehouse'],
    messages: [
      {from: 'Analyst', to: 'querygen', label: 'POST /v1/queries/{id}/run · X-User-Id', kind: 'sync'},
      {from: 'querygen', to: 'query store', label: 'get(id) → 404 / 403', kind: 'sync'},
      {from: 'querygen', to: 'querygen', label: 'one SELECT · tables ⊆ acked · datestr filter → 422', kind: 'sync'},
      {from: 'querygen', to: 'Warehouse', label: 'Execute(sql LIMIT 1000) · deadline 60 s', kind: 'sync'},
      {from: 'Warehouse', to: 'querygen', label: 'rows / DEADLINE_EXCEEDED → 504', kind: 'reply'},
      {from: 'querygen', to: 'query store', label: 'save(run_ok, has_output)', kind: 'sync'},
      {from: 'querygen', to: 'Analyst', label: '200 {row_count, has_output, rows}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/queries/{id}/run',
      detail:
        "The owner's run answers 200 with row_count, columns and rows from the warehouse; no X-User-Id is 401, an unknown id 404, another user's record 403.",
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
        'A second statement after a semicolon, a DELETE and an UPDATE are 422 and never reach the warehouse; a SELECT with a trailing semicolon runs. The starter executes whatever the model wrote.',
      match: {
        python: {all: [/is_single_select\(/, /status_code\s*=\s*422/]},
        typescript: {all: [/isSingleSelect\(/, /code\(\s*422\s*\)/]},
        go: {all: [/isSingleSelect\(/, /StatusUnprocessableEntity/]},
        scala: {all: [/isSingleSelect\(/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/is_single_select\(/, /\b422\b/]},
      },
    },
    {
      id: 'tables-acked',
      title: 'Rejects tables outside the ACKed list',
      detail:
        'A JOIN on drivers when only trips was ACKed is 422 with no warehouse call; the same SQL runs once drivers is ACKed, and FROM TRIPS matches trips. The starter lets any table through.',
      match: {
        python: {all: [/referenced_tables\(/, /tables_acked/]},
        typescript: {all: [/referencedTables\(/, /tables_acked/]},
        go: {all: [/referencedTables\(/, /TablesAcked/]},
        scala: {all: [/referencedTables\(/, /tables_acked/]},
        cpp: {all: [/referenced_tables\(/, /"tables_acked"/]},
      },
    },
    {
      id: 'partition-filter',
      title: 'Requires a filter on the partition column',
      detail:
        'A query with no WHERE, or a WHERE without datestr, is 422 instead of a scan of every partition; a datestr range in any case runs. The starter sends both to the warehouse.',
      match: {
        python: {all: [/has_partition_filter\(/, /PARTITION_COLUMN/]},
        typescript: {all: [/hasPartitionFilter\(/, /PARTITION_COLUMN/]},
        go: {all: [/hasPartitionFilter\(/, /config\.PartitionColumn/]},
        scala: {all: [/hasPartitionFilter\(/, /Config\.PartitionColumn/]},
        cpp: {all: [/has_partition_filter\(/, /config::kPartitionColumn/]},
      },
    },
    {
      id: 'limit-timeout',
      title: 'Caps rows at 1000 and the statement at 60 s',
      detail:
        'The warehouse receives the statement ending in LIMIT 1000 (a LIMIT 5000 lowered, a LIMIT 10 kept), the call carries a deadline of about 60 s, and a statement that runs 90 s answers 504 at the deadline. The starter runs the query unbounded in rows and time.',
      match: {
        python: {all: [/with_limit\(/, /timeout\s*=\s*STATEMENT_TIMEOUT_S/]},
        typescript: {all: [/withLimit\(/, /deadline:\s*Date\.now\(\)\s*\+\s*STATEMENT_TIMEOUT_MS/]},
        go: {all: [/withLimit\(/, /context\.WithTimeout\([^\n]*statementTimeout/]},
        scala: {all: [/withLimit\(/, /withDeadlineAfter\(\s*StatementTimeoutMs/]},
        cpp: {all: [/with_limit\(/, /set_deadline\([^\n]*kStatementTimeout/]},
      },
    },
    {
      id: 'run-signals',
      title: 'Reports has_output and saves it with run_ok',
      detail:
        "A query that runs and returns no rows (the hallucinated status = 'Finished') answers has_output false, and the record is saved with status ran, run_ok and has_output, the signals step 5 publishes. The starter saves run_ok alone.",
      match: {
        python: {all: [/["']has_output["']/, /store\.save\(/]},
        typescript: {all: [/has_output/, /store\.save\(/]},
        go: {all: [/HasOutput/, /queries\.Save\(/]},
        scala: {all: [/has_output/, /Queries\.save\(/]},
        cpp: {all: [/"has_output"/, /queries::save\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import text_to_sql_pb2
import text_to_sql_pb2_grpc
from querygen.config import WAREHOUSE
from querygen.queries import store

app = FastAPI()
warehouse = text_to_sql_pb2_grpc.WarehouseStub(grpc.insecure_channel(WAREHOUSE))


@app.post("/v1/queries/{query_id}/run")
def run_query(query_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    user = request.headers.get("x-user-id", "")
    if user == "":
        return JSONResponse({"error": "missing X-User-Id"}, status_code=401)
    record = store.get(query_id)
    if record is None:
        return JSONResponse({"error": "no such query"}, status_code=404)
    if record["user"] != user:
        return JSONResponse({"error": "not your query"}, status_code=403)
    try:
        reply = warehouse.Execute(text_to_sql_pb2.ExecuteRequest(sql=record["sql"]))
    except grpc.RpcError as err:
        return JSONResponse({"error": f"warehouse: {err.code().name}"}, status_code=502)
    rows = [list(row.values) for row in reply.rows]
    record["status"] = "ran"
    record["run_ok"] = True
    store.save(record)
    return JSONResponse({"query_id": query_id, "run_ok": True, "row_count": len(rows), "columns": list(reply.columns), "rows": rows})
`,
      solution: `import re

import grpc
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import text_to_sql_pb2
import text_to_sql_pb2_grpc
from querygen.config import PARTITION_COLUMN, WAREHOUSE
from querygen.queries import store

app = FastAPI()
warehouse = text_to_sql_pb2_grpc.WarehouseStub(grpc.insecure_channel(WAREHOUSE))

MAX_ROWS = 1000
STATEMENT_TIMEOUT_S = 60

TABLE_REF = re.compile(r"\\b(?:from|join)\\s+([a-z_][\\w.]*)", re.IGNORECASE)
PARTITION_FILTER = re.compile(rf"\\bwhere\\b[\\s\\S]*\\b{PARTITION_COLUMN}\\b", re.IGNORECASE)
TRAILING_LIMIT = re.compile(r"\\blimit\\s+(\\d+)\\s*$", re.IGNORECASE)


def statement_of(sql: str) -> str:
    return sql.strip().rstrip(";").strip()


def is_single_select(sql: str) -> bool:
    """One statement, and a read: SELECT or WITH first, no second statement after a semicolon."""
    statement = statement_of(sql)
    words = statement.split(None, 1)
    return ";" not in statement and bool(words) and words[0].upper() in ("SELECT", "WITH")


def referenced_tables(sql: str) -> set[str]:
    """Every FROM and JOIN target, lower-cased."""
    return {name.lower() for name in TABLE_REF.findall(sql)}


def has_partition_filter(sql: str) -> bool:
    """The WHERE clause names the partition column, so the warehouse prunes partitions."""
    return PARTITION_FILTER.search(sql) is not None


def with_limit(sql: str) -> str:
    """The statement capped at MAX_ROWS: a LIMIT appended, or a larger one lowered."""
    statement = statement_of(sql)
    m = TRAILING_LIMIT.search(statement)
    if m is None:
        return f"{statement} LIMIT {MAX_ROWS}"
    if int(m.group(1)) > MAX_ROWS:
        return f"{statement[: m.start()]}LIMIT {MAX_ROWS}"
    return statement


def reject(message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=422)


@app.post("/v1/queries/{query_id}/run")
def run_query(query_id: str, request: Request) -> JSONResponse:
    user = request.headers.get("x-user-id", "")
    if user == "":
        return JSONResponse({"error": "missing X-User-Id"}, status_code=401)
    record = store.get(query_id)
    if record is None:
        return JSONResponse({"error": "no such query"}, status_code=404)
    if record["user"] != user:
        return JSONResponse({"error": "not your query"}, status_code=403)

    # The model wrote this SQL: nothing reaches the warehouse until it passes every guard.
    sql = record.get("sql") or ""
    if not is_single_select(sql):
        return reject("only a single SELECT runs")
    unacked = referenced_tables(sql) - {t.lower() for t in record.get("tables_acked", [])}
    if unacked:
        return reject(f"tables outside the ACKed list: {', '.join(sorted(unacked))}")
    if not has_partition_filter(sql):
        return reject(f"the query must filter on {PARTITION_COLUMN}")

    try:
        reply = warehouse.Execute(text_to_sql_pb2.ExecuteRequest(sql=with_limit(sql)), timeout=STATEMENT_TIMEOUT_S)
    except grpc.RpcError as err:
        record.update(status="ran", run_ok=False, has_output=False)
        store.save(record)
        timed_out = err.code() == grpc.StatusCode.DEADLINE_EXCEEDED
        return JSONResponse({"error": f"warehouse: {err.code().name}"}, status_code=504 if timed_out else 502)
    rows = [list(row.values) for row in reply.rows]
    # A query can run and return nothing (a hallucinated filter): that is its own signal, not success.
    has_output = len(rows) > 0
    record.update(status="ran", run_ok=True, has_output=has_output)
    store.save(record)
    return JSONResponse(
        {"query_id": query_id, "run_ok": True, "row_count": len(rows), "has_output": has_output, "columns": list(reply.columns), "rows": rows}
    )
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {WAREHOUSE} from 'querygen/config';
import {store} from 'querygen/queries';

interface WarehouseClient {
  Execute(request: {sql: string}, options?: {deadline: number}): Promise<{columns: string[]; rows: {values: string[]}[]}>;
}

const {sqlagents} = grpc.loadPackageDefinition(protoLoader.loadSync('text_to_sql.proto')) as unknown as {
  sqlagents: {Warehouse: new (target: string, credentials: grpc.ChannelCredentials) => WarehouseClient};
};
const warehouse = new sqlagents.Warehouse(WAREHOUSE, grpc.credentials.createInsecure());

export const app = Fastify();

app.post('/v1/queries/:id/run', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const {id} = request.params as {id: string};
  const record = await store.get(id);
  if (record === null) return reply.code(404).send({error: 'no such query'});
  if (record.user !== user) return reply.code(403).send({error: 'not your query'});
  let result: {columns: string[]; rows: {values: string[]}[]};
  try {
    result = await warehouse.Execute({sql: record.sql});
  } catch (err) {
    return reply.code(502).send({error: \`warehouse: \${grpc.status[(err as grpc.ServiceError).code]}\`});
  }
  const rows = result.rows.map(row => row.values);
  await store.save({...record, status: 'ran', run_ok: true});
  return reply.send({query_id: id, run_ok: true, row_count: rows.length, columns: result.columns, rows});
});
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {PARTITION_COLUMN, WAREHOUSE} from 'querygen/config';
import {store} from 'querygen/queries';

export const MAX_ROWS = 1000;
export const STATEMENT_TIMEOUT_MS = 60_000;

interface WarehouseClient {
  Execute(request: {sql: string}, options?: {deadline: number}): Promise<{columns: string[]; rows: {values: string[]}[]}>;
}

const {sqlagents} = grpc.loadPackageDefinition(protoLoader.loadSync('text_to_sql.proto')) as unknown as {
  sqlagents: {Warehouse: new (target: string, credentials: grpc.ChannelCredentials) => WarehouseClient};
};
const warehouse = new sqlagents.Warehouse(WAREHOUSE, grpc.credentials.createInsecure());

const TABLE_REF = /\\b(?:from|join)\\s+([a-z_][\\w.]*)/gi;
const PARTITION_FILTER = new RegExp(\`\\\\bwhere\\\\b[\\\\s\\\\S]*\\\\b\${PARTITION_COLUMN}\\\\b\`, 'i');
const TRAILING_LIMIT = /\\blimit\\s+(\\d+)\\s*$/i;

const statementOf = (sql: string): string => sql.trim().replace(/;+\\s*$/, '').trim();

/** One statement, and a read: SELECT or WITH first, no second statement after a semicolon. */
export function isSingleSelect(sql: string): boolean {
  const statement = statementOf(sql);
  const first = statement.split(/\\s+/, 1)[0].toUpperCase();
  return !statement.includes(';') && (first === 'SELECT' || first === 'WITH');
}

/** Every FROM and JOIN target, lower-cased. */
export function referencedTables(sql: string): string[] {
  return [...sql.matchAll(TABLE_REF)].map(m => m[1].toLowerCase());
}

/** The WHERE clause names the partition column, so the warehouse prunes partitions. */
export function hasPartitionFilter(sql: string): boolean {
  return PARTITION_FILTER.test(sql);
}

/** The statement capped at MAX_ROWS: a LIMIT appended, or a larger one lowered. */
export function withLimit(sql: string): string {
  const statement = statementOf(sql);
  const m = TRAILING_LIMIT.exec(statement);
  if (m === null) return \`\${statement} LIMIT \${MAX_ROWS}\`;
  if (Number(m[1]) > MAX_ROWS) return \`\${statement.slice(0, m.index)}LIMIT \${MAX_ROWS}\`;
  return statement;
}

export const app = Fastify();

app.post('/v1/queries/:id/run', async (request, reply) => {
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const {id} = request.params as {id: string};
  const record = await store.get(id);
  if (record === null) return reply.code(404).send({error: 'no such query'});
  if (record.user !== user) return reply.code(403).send({error: 'not your query'});

  // The model wrote this SQL: nothing reaches the warehouse until it passes every guard.
  const sql = record.sql ?? '';
  if (!isSingleSelect(sql)) return reply.code(422).send({error: 'only a single SELECT runs'});
  const acked = record.tables_acked.map(t => t.toLowerCase());
  const unacked = referencedTables(sql).filter(t => !acked.includes(t));
  if (unacked.length > 0) return reply.code(422).send({error: \`tables outside the ACKed list: \${unacked.join(', ')}\`});
  if (!hasPartitionFilter(sql)) return reply.code(422).send({error: \`the query must filter on \${PARTITION_COLUMN}\`});

  let result: {columns: string[]; rows: {values: string[]}[]};
  try {
    result = await warehouse.Execute({sql: withLimit(sql)}, {deadline: Date.now() + STATEMENT_TIMEOUT_MS});
  } catch (err) {
    await store.save({...record, status: 'ran', run_ok: false, has_output: false});
    const code = (err as grpc.ServiceError).code;
    return reply.code(code === grpc.status.DEADLINE_EXCEEDED ? 504 : 502).send({error: \`warehouse: \${grpc.status[code]}\`});
  }
  const rows = result.rows.map(row => row.values);
  // A query can run and return nothing (a hallucinated filter): that is its own signal, not success.
  const hasOutput = rows.length > 0;
  await store.save({...record, status: 'ran', run_ok: true, has_output: hasOutput});
  return reply.send({query_id: id, run_ok: true, row_count: rows.length, has_output: hasOutput, columns: result.columns, rows});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"querygen/config"  // config.Warehouse — provided
	"querygen/queries" // queries.Record, queries.Get/Save — provided
	pb "sqlagents/gen/text_to_sql"
)

var conn, _ = grpc.NewClient(config.Warehouse, grpc.WithTransportCredentials(insecure.NewCredentials()))
var warehouse = pb.NewWarehouseClient(conn)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func runQuery(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	user := r.Header.Get("X-User-Id")
	if user == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	id := r.PathValue("id")
	rec, err := queries.Get(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if rec == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such query"})
		return
	}
	if rec.User != user {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "not your query"})
		return
	}
	reply, err := warehouse.Execute(r.Context(), &pb.ExecuteRequest{Sql: rec.SQL})
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "warehouse: " + err.Error()})
		return
	}
	rows := make([][]string, 0, len(reply.GetRows()))
	for _, row := range reply.GetRows() {
		rows = append(rows, row.GetValues())
	}
	rec.Status = "ran"
	rec.RunOK = true
	queries.Save(r.Context(), *rec)
	writeJSON(rw, http.StatusOK, map[string]any{"query_id": id, "run_ok": true, "row_count": len(rows), "columns": reply.GetColumns(), "rows": rows})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/queries/{id}/run", runQuery)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"querygen/config"  // config.Warehouse, config.PartitionColumn — provided
	"querygen/queries" // queries.Record, queries.Get/Save — provided
	pb "sqlagents/gen/text_to_sql"
)

const (
	maxRows          = 1000
	statementTimeout = 60 * time.Second
)

var conn, _ = grpc.NewClient(config.Warehouse, grpc.WithTransportCredentials(insecure.NewCredentials()))
var warehouse = pb.NewWarehouseClient(conn)

var (
	tableRef        = regexp.MustCompile(\`(?i)\\b(?:from|join)\\s+([a-z_][\\w.]*)\`)
	partitionFilter = regexp.MustCompile(\`(?i)\\bwhere\\b[\\s\\S]*\\b\` + config.PartitionColumn + \`\\b\`)
	trailingLimit   = regexp.MustCompile(\`(?i)\\blimit\\s+(\\d+)\\s*$\`)
)

func statementOf(sql string) string {
	return strings.TrimSpace(strings.TrimRight(strings.TrimSpace(sql), ";"))
}

// isSingleSelect: one statement, and a read (SELECT or WITH first, no second statement after a semicolon).
func isSingleSelect(sql string) bool {
	statement := statementOf(sql)
	words := strings.Fields(statement)
	if strings.Contains(statement, ";") || len(words) == 0 {
		return false
	}
	first := strings.ToUpper(words[0])
	return first == "SELECT" || first == "WITH"
}

// referencedTables is every FROM and JOIN target, lower-cased.
func referencedTables(sql string) []string {
	var tables []string
	for _, m := range tableRef.FindAllStringSubmatch(sql, -1) {
		tables = append(tables, strings.ToLower(m[1]))
	}
	return tables
}

// hasPartitionFilter: the WHERE clause names the partition column, so the warehouse prunes partitions.
func hasPartitionFilter(sql string) bool { return partitionFilter.MatchString(sql) }

// withLimit is the statement capped at maxRows: a LIMIT appended, or a larger one lowered.
func withLimit(sql string) string {
	statement := statementOf(sql)
	m := trailingLimit.FindStringSubmatchIndex(statement)
	if m == nil {
		return statement + " LIMIT " + strconv.Itoa(maxRows)
	}
	if n, _ := strconv.Atoi(statement[m[2]:m[3]]); n > maxRows {
		return statement[:m[0]] + "LIMIT " + strconv.Itoa(maxRows)
	}
	return statement
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func runQuery(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	if user == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	id := r.PathValue("id")
	rec, err := queries.Get(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if rec == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such query"})
		return
	}
	if rec.User != user {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "not your query"})
		return
	}

	// The model wrote this SQL: nothing reaches the warehouse until it passes every guard.
	reject := func(message string) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": message})
	}
	if !isSingleSelect(rec.SQL) {
		reject("only a single SELECT runs")
		return
	}
	acked := map[string]bool{}
	for _, t := range rec.TablesAcked {
		acked[strings.ToLower(t)] = true
	}
	var unacked []string
	for _, t := range referencedTables(rec.SQL) {
		if !acked[t] {
			unacked = append(unacked, t)
		}
	}
	if len(unacked) > 0 {
		sort.Strings(unacked)
		reject("tables outside the ACKed list: " + strings.Join(unacked, ", "))
		return
	}
	if !hasPartitionFilter(rec.SQL) {
		reject("the query must filter on " + config.PartitionColumn)
		return
	}

	callCtx, cancel := context.WithTimeout(r.Context(), statementTimeout)
	reply, err := warehouse.Execute(callCtx, &pb.ExecuteRequest{Sql: withLimit(rec.SQL)})
	cancel()
	rec.Status = "ran"
	if err != nil {
		rec.RunOK, rec.HasOutput = false, false
		queries.Save(r.Context(), *rec)
		code := http.StatusBadGateway
		if status.Code(err) == codes.DeadlineExceeded {
			code = http.StatusGatewayTimeout
		}
		writeJSON(rw, code, map[string]string{"error": "warehouse: " + status.Code(err).String()})
		return
	}
	rows := make([][]string, 0, len(reply.GetRows()))
	for _, row := range reply.GetRows() {
		rows = append(rows, row.GetValues())
	}
	// A query can run and return nothing (a hallucinated filter): that is its own signal, not success.
	rec.RunOK, rec.HasOutput = true, len(rows) > 0
	queries.Save(r.Context(), *rec)
	writeJSON(rw, http.StatusOK, map[string]any{"query_id": id, "run_ok": true, "row_count": len(rows), "has_output": rec.HasOutput, "columns": reply.GetColumns(), "rows": rows})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/queries/{id}/run", runQuery)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import querygen.{Config, Queries}
import sqlagents.text_to_sql.{ExecuteRequest, WarehouseGrpc}

object RunApi {
  implicit val system: ActorSystem = ActorSystem("querygen-run")

  private val channel = ManagedChannelBuilder.forTarget(Config.Warehouse).usePlaintext().build()
  private val warehouse = WarehouseGrpc.blockingStub(channel)

  private def json(status: StatusCode, body: ujson.Value): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  val route: Route =
    path("v1" / "queries" / Segment / "run") { id =>
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
          if (!userOpt.exists(_.nonEmpty)) json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-User-Id"))
          else
            Queries.get(id) match {
              case None => json(StatusCodes.NotFound, ujson.Obj("error" -> "no such query"))
              case Some(record) if record.user != userOpt.get => json(StatusCodes.Forbidden, ujson.Obj("error" -> "not your query"))
              case Some(record) =>
                try {
                  val reply = warehouse.execute(ExecuteRequest(sql = record.sql))
                  val rows = reply.rows.map(_.values.toList).toList
                  Queries.save(record.copy(status = "ran", run_ok = true))
                  json(
                    StatusCodes.OK,
                    ujson.Obj(
                      "query_id" -> id,
                      "run_ok" -> true,
                      "row_count" -> rows.size,
                      "columns" -> ujson.Arr.from(reply.columns.map(ujson.Str(_))),
                      "rows" -> ujson.Arr.from(rows.map(r => ujson.Arr.from(r.map(ujson.Str(_)))))
                    )
                  )
                } catch {
                  case e: StatusRuntimeException => json(StatusCodes.BadGateway, ujson.Obj("error" -> s"warehouse: \${e.getStatus.getCode}"))
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
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import querygen.{Config, Queries}
import sqlagents.text_to_sql.{ExecuteRequest, WarehouseGrpc}

object RunApi {
  implicit val system: ActorSystem = ActorSystem("querygen-run")

  val MaxRows = 1000
  val StatementTimeoutMs = 60000L

  private val channel = ManagedChannelBuilder.forTarget(Config.Warehouse).usePlaintext().build()
  private val warehouse = WarehouseGrpc.blockingStub(channel)

  private val TableRef = """(?i)\\b(?:from|join)\\s+([a-z_][\\w.]*)""".r
  private val PartitionFilter = s"""(?i)\\\\bwhere\\\\b[\\\\s\\\\S]*\\\\b\${Config.PartitionColumn}\\\\b""".r
  private val TrailingLimit = """(?i)\\blimit\\s+(\\d+)\\s*$""".r

  private def statementOf(sql: String): String = sql.trim.reverse.dropWhile(c => c == ';' || c.isWhitespace).reverse

  /** One statement, and a read: SELECT or WITH first, no second statement after a semicolon. */
  def isSingleSelect(sql: String): Boolean = {
    val statement = statementOf(sql)
    val first = statement.split("\\\\s+").headOption.getOrElse("").toUpperCase
    !statement.contains(";") && (first == "SELECT" || first == "WITH")
  }

  /** Every FROM and JOIN target, lower-cased. */
  def referencedTables(sql: String): List[String] = TableRef.findAllMatchIn(sql).map(_.group(1).toLowerCase).toList

  /** The WHERE clause names the partition column, so the warehouse prunes partitions. */
  def hasPartitionFilter(sql: String): Boolean = PartitionFilter.findFirstIn(sql).isDefined

  /** The statement capped at MaxRows: a LIMIT appended, or a larger one lowered. */
  def withLimit(sql: String): String = {
    val statement = statementOf(sql)
    TrailingLimit.findFirstMatchIn(statement) match {
      case None => s"$statement LIMIT $MaxRows"
      case Some(m) if m.group(1).toInt > MaxRows => s"\${statement.substring(0, m.start)}LIMIT $MaxRows"
      case Some(_) => statement
    }
  }

  private def json(status: StatusCode, body: ujson.Value): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  private def reject(message: String): Route = json(StatusCodes.UnprocessableEntity, ujson.Obj("error" -> message))

  val route: Route =
    path("v1" / "queries" / Segment / "run") { id =>
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          if (!userOpt.exists(_.nonEmpty)) json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-User-Id"))
          else
            Queries.get(id) match {
              case None => json(StatusCodes.NotFound, ujson.Obj("error" -> "no such query"))
              case Some(record) if record.user != userOpt.get => json(StatusCodes.Forbidden, ujson.Obj("error" -> "not your query"))
              case Some(record) =>
                // The model wrote this SQL: nothing reaches the warehouse until it passes every guard.
                val sql = record.sql
                val unacked = referencedTables(sql).filterNot(record.tables_acked.map(_.toLowerCase).contains)
                if (!isSingleSelect(sql)) reject("only a single SELECT runs")
                else if (unacked.nonEmpty) reject(s"tables outside the ACKed list: \${unacked.mkString(", ")}")
                else if (!hasPartitionFilter(sql)) reject(s"the query must filter on \${Config.PartitionColumn}")
                else
                  try {
                    val reply = warehouse
                      .withDeadlineAfter(StatementTimeoutMs, TimeUnit.MILLISECONDS)
                      .execute(ExecuteRequest(sql = withLimit(sql)))
                    val rows = reply.rows.map(_.values.toList).toList
                    // A query can run and return nothing (a hallucinated filter): that is its own signal, not success.
                    val hasOutput = rows.nonEmpty
                    Queries.save(record.copy(status = "ran", run_ok = true, has_output = hasOutput))
                    json(
                      StatusCodes.OK,
                      ujson.Obj(
                        "query_id" -> id,
                        "run_ok" -> true,
                        "row_count" -> rows.size,
                        "has_output" -> hasOutput,
                        "columns" -> ujson.Arr.from(reply.columns.map(ujson.Str(_))),
                        "rows" -> ujson.Arr.from(rows.map(r => ujson.Arr.from(r.map(ujson.Str(_)))))
                      )
                    )
                  } catch {
                    case e: StatusRuntimeException =>
                      Queries.save(record.copy(status = "ran", run_ok = false, has_output = false))
                      val timedOut = e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED
                      json(if (timedOut) StatusCodes.GatewayTimeout else StatusCodes.BadGateway, ujson.Obj("error" -> s"warehouse: \${e.getStatus.getCode}"))
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
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "querygen/config.h"   // config::kWarehouse — provided
#include "querygen/queries.h"  // queries::get/save — provided
#include "text_to_sql.grpc.pb.h"

using json = nlohmann::json;

auto channel = grpc::CreateChannel(config::kWarehouse, grpc::InsecureChannelCredentials());
auto stub = sqlagents::Warehouse::NewStub(channel);

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void run_query(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string user = req.get_header_value("X-User-Id");
  if (user.empty()) return reply_json(res, 401, {{"error", "missing X-User-Id"}});
  const std::string id = req.matches[1];
  auto record = queries::get(id);
  if (!record) return reply_json(res, 404, {{"error", "no such query"}});
  if (record->value("user", "") != user) return reply_json(res, 403, {{"error", "not your query"}});
  grpc::ClientContext ctx;
  sqlagents::ExecuteRequest request;
  request.set_sql(record->value("sql", ""));
  sqlagents::ExecuteReply reply;
  const grpc::Status status = stub->Execute(&ctx, request, &reply);
  if (!status.ok()) return reply_json(res, 502, {{"error", "warehouse: " + status.error_message()}});
  json rows = json::array();
  for (const auto& row : reply.rows()) rows.push_back(std::vector<std::string>(row.values().begin(), row.values().end()));
  (*record)["status"] = "ran";
  (*record)["run_ok"] = true;
  queries::save(*record);
  reply_json(res, 200,
             {{"query_id", id}, {"run_ok", true}, {"row_count", rows.size()},
              {"columns", std::vector<std::string>(reply.columns().begin(), reply.columns().end())}, {"rows", rows}});
}

void register_routes(httplib::Server& svr) { svr.Post(R"(/v1/queries/([^/]+)/run)", run_query); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <regex>
#include <set>
#include <string>
#include <vector>

#include "querygen/config.h"   // config::kWarehouse, config::kPartitionColumn — provided
#include "querygen/queries.h"  // queries::get/save — provided
#include "text_to_sql.grpc.pb.h"

using json = nlohmann::json;

constexpr int kMaxRows = 1000;
constexpr std::chrono::seconds kStatementTimeout{60};

auto channel = grpc::CreateChannel(config::kWarehouse, grpc::InsecureChannelCredentials());
auto stub = sqlagents::Warehouse::NewStub(channel);

const std::regex kTableRef(R"(\\b(?:from|join)\\s+([A-Za-z_][\\w.]*))", std::regex::icase);
const std::regex kPartitionFilter(std::string(R"(\\bwhere\\b[\\s\\S]*\\b)") + config::kPartitionColumn + R"(\\b)", std::regex::icase);
const std::regex kTrailingLimit(R"(\\blimit\\s+(\\d+)\\s*$)", std::regex::icase);

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

std::string statement_of(const std::string& sql) {
  const size_t last = sql.find_last_not_of(" \\t\\r\\n;");
  if (last == std::string::npos) return "";
  const size_t first = sql.find_first_not_of(" \\t\\r\\n");
  return sql.substr(first, last - first + 1);
}

// One statement, and a read: SELECT or WITH first, no second statement after a semicolon.
bool is_single_select(const std::string& sql) {
  const std::string statement = statement_of(sql);
  const std::string first = lower(statement.substr(0, statement.find_first_of(" \\t\\r\\n")));
  return statement.find(';') == std::string::npos && (first == "select" || first == "with");
}

// Every FROM and JOIN target, lower-cased.
std::vector<std::string> referenced_tables(const std::string& sql) {
  std::vector<std::string> tables;
  for (auto it = std::sregex_iterator(sql.begin(), sql.end(), kTableRef); it != std::sregex_iterator(); ++it) tables.push_back(lower((*it)[1].str()));
  return tables;
}

// The WHERE clause names the partition column, so the warehouse prunes partitions.
bool has_partition_filter(const std::string& sql) { return std::regex_search(sql, kPartitionFilter); }

// The statement capped at kMaxRows: a LIMIT appended, or a larger one lowered.
std::string with_limit(const std::string& sql) {
  const std::string statement = statement_of(sql);
  std::smatch m;
  if (!std::regex_search(statement, m, kTrailingLimit)) return statement + " LIMIT " + std::to_string(kMaxRows);
  if (std::stoll(m[1].str()) > kMaxRows) return statement.substr(0, m.position(0)) + "LIMIT " + std::to_string(kMaxRows);
  return statement;
}

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void run_query(const httplib::Request& req, httplib::Response& res) {
  const std::string user = req.get_header_value("X-User-Id");
  if (user.empty()) return reply_json(res, 401, {{"error", "missing X-User-Id"}});
  const std::string id = req.matches[1];
  auto record = queries::get(id);
  if (!record) return reply_json(res, 404, {{"error", "no such query"}});
  if (record->value("user", "") != user) return reply_json(res, 403, {{"error", "not your query"}});

  // The model wrote this SQL: nothing reaches the warehouse until it passes every guard.
  const std::string sql = record->value("sql", "");
  if (!is_single_select(sql)) return reply_json(res, 422, {{"error", "only a single SELECT runs"}});
  std::set<std::string> acked;
  for (const auto& t : record->value("tables_acked", json::array())) acked.insert(lower(t.get<std::string>()));
  for (const auto& t : referenced_tables(sql)) {
    if (acked.count(t) == 0) return reply_json(res, 422, {{"error", "tables outside the ACKed list: " + t}});
  }
  if (!has_partition_filter(sql)) return reply_json(res, 422, {{"error", std::string("the query must filter on ") + config::kPartitionColumn}});

  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kStatementTimeout);
  sqlagents::ExecuteRequest request;
  request.set_sql(with_limit(sql));
  sqlagents::ExecuteReply reply;
  const grpc::Status status = stub->Execute(&ctx, request, &reply);
  (*record)["status"] = "ran";
  if (!status.ok()) {
    (*record)["run_ok"] = false;
    (*record)["has_output"] = false;
    queries::save(*record);
    return reply_json(res, status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED ? 504 : 502,
                      {{"error", "warehouse: " + status.error_message()}});
  }
  json rows = json::array();
  for (const auto& row : reply.rows()) rows.push_back(std::vector<std::string>(row.values().begin(), row.values().end()));
  // A query can run and return nothing (a hallucinated filter): that is its own signal, not success.
  const bool has_output = !rows.empty();
  (*record)["run_ok"] = true;
  (*record)["has_output"] = has_output;
  queries::save(*record);
  reply_json(res, 200,
             {{"query_id", id}, {"run_ok", true}, {"row_count", rows.size()}, {"has_output", has_output},
              {"columns", std::vector<std::string>(reply.columns().begin(), reply.columns().end())}, {"rows", rows}});
}

void register_routes(httplib::Server& svr) { svr.Post(R"(/v1/queries/([^/]+)/run)", run_query); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json
import re

import text_to_sql_pb2
import text_to_sql_pb2_grpc
from querygen import config, warehouse

GOOD_SQL = "SELECT trip_uuid FROM trips WHERE datestr = '2026-11-01'"


class WarehouseServicer(text_to_sql_pb2_grpc.WarehouseServicer):
    """The stand-in warehouse: answers from querygen.warehouse."""

    def Execute(self, request, context):
        rows = warehouse.execute(request.sql)
        return text_to_sql_pb2.ExecuteReply(columns=warehouse.COLUMNS, rows=[text_to_sql_pb2.Row(values=r) for r in rows])


def _seed(ctx, query_id="q1", sql=GOOD_SQL, acked=("trips",), user="ana"):
    record = {
        "query_id": query_id, "user": user, "workspace": "mobility", "question": "How many trips yesterday?",
        "status": "generated", "tables_proposed": list(acked), "tables_acked": list(acked), "sql": sql,
        "run_ok": False, "has_output": False,
    }
    ctx.redis.set(f"query:{query_id}", json.dumps(record))


def _stored(ctx, query_id="q1"):
    return json.loads(ctx.redis.get(f"query:{query_id}"))


def _api(ctx):
    ctx.grpc.serve(text_to_sql_pb2_grpc.add_WarehouseServicer_to_server, WarehouseServicer(), config.WAREHOUSE)
    m = ctx.load("run_api")
    return ctx.client(m.app)


async def _run(c, query_id="q1", user="ana"):
    headers = {"X-User-Id": user} if user else {}
    return await c.post(f"/v1/queries/{query_id}/run", headers=headers)


def _executed(ctx):
    return [call.request.sql for call in ctx.grpc.calls_to("Execute")]


async def _expect_refused(ctx, c, query_id, sql, why):
    before = len(_executed(ctx))
    r = await _run(c, query_id)
    assert r.status_code == 422, f"{why}: {sql!r} answered {r.status_code}, expected 422"
    assert len(_executed(ctx)) == before, f"{why}: {sql!r} reached the warehouse"


async def check_route(ctx):
    _seed(ctx)
    async with _api(ctx) as c:
        r = await _run(c)
        assert r.status_code == 200, f"the owner's run answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("columns") == ["datestr", "trip_uuid"], f"the answer carries the warehouse's columns, got {body.get('columns')}"
        assert isinstance(body.get("rows"), list) and body.get("row_count") == len(body["rows"]) > 0, f"row_count must count the rows returned: {body.get('row_count')} vs {len(body.get('rows') or [])}"
        assert (await _run(c, user=None)).status_code == 401, "without X-User-Id the run must answer 401"
        assert (await _run(c, query_id="nope")).status_code == 404, "an unknown query id must answer 404"
        assert (await _run(c, user="ben")).status_code == 403, "another user's query must answer 403"


async def check_single_select(ctx):
    bad = [
        GOOD_SQL + "; DROP TABLE trips",
        "DELETE FROM trips WHERE datestr = '2026-11-01'",
        "UPDATE trips SET status = 'void' WHERE datestr = '2026-11-01'",
    ]
    for i, sql in enumerate(bad):
        _seed(ctx, f"q{i}", sql)
    _seed(ctx, "ok", GOOD_SQL + ";")
    async with _api(ctx) as c:
        for i, sql in enumerate(bad):
            await _expect_refused(ctx, c, f"q{i}", sql, "only one SELECT may run")
        r = await _run(c, "ok")
        assert r.status_code == 200, f"a single SELECT with a trailing semicolon must run, got {r.status_code}: {r.text}"


async def check_tables_acked(ctx):
    join = "SELECT t.trip_uuid, d.rating FROM trips t JOIN drivers d ON t.driver_uuid = d.driver_uuid WHERE t.datestr = '2026-11-01'"
    _seed(ctx, "q1", join, acked=("trips",))
    _seed(ctx, "q2", join, acked=("trips", "drivers"))
    _seed(ctx, "q3", "SELECT trip_uuid FROM TRIPS WHERE datestr = '2026-11-01'", acked=("trips",))
    async with _api(ctx) as c:
        await _expect_refused(ctx, c, "q1", join, "drivers was never ACKed")
        r = await _run(c, "q2")
        assert r.status_code == 200, f"with trips and drivers ACKed the join must run, got {r.status_code}: {r.text}"
        r = await _run(c, "q3")
        assert r.status_code == 200, f"FROM TRIPS names the ACKed table trips (compare case-insensitively), got {r.status_code}: {r.text}"


async def check_partition_filter(ctx):
    _seed(ctx, "q1", "SELECT trip_uuid FROM trips WHERE status = 'completed'")
    _seed(ctx, "q2", "SELECT trip_uuid FROM trips")
    _seed(ctx, "q3", "SELECT trip_uuid FROM trips WHERE DATESTR >= '2026-10-01'")
    async with _api(ctx) as c:
        await _expect_refused(ctx, c, "q1", "SELECT trip_uuid FROM trips WHERE status = 'completed'", "a WHERE without datestr scans every partition")
        await _expect_refused(ctx, c, "q2", "SELECT trip_uuid FROM trips", "no WHERE at all scans every partition")
        r = await _run(c, "q3")
        assert r.status_code == 200, f"a datestr range (any case) is a partition filter, got {r.status_code}: {r.text}"


async def check_limit_timeout(ctx):
    _seed(ctx, "q1")
    _seed(ctx, "q2", GOOD_SQL + " LIMIT 5000")
    _seed(ctx, "q3", GOOD_SQL + " LIMIT 10")
    async with _api(ctx) as c:
        r = await _run(c, "q1")
        sent = _executed(ctx)[-1]
        assert re.search(r"(?i)\\blimit\\s+1000\\s*$", sent), f"the warehouse received {sent!r}: it must end in LIMIT 1000"
        assert r.json().get("row_count") == 1000, f"a capped query returns at most 1000 rows, got {r.json().get('row_count')}"
        timeout = ctx.grpc.calls_to("Execute")[-1].timeout
        assert timeout is not None and 59 <= timeout <= 61, f"the Execute call must carry STATEMENT_TIMEOUT_S = 60 s, got {timeout}"
        await _run(c, "q2")
        sent = _executed(ctx)[-1]
        assert re.search(r"(?i)\\blimit\\s+1000\\s*$", sent) and "5000" not in sent, f"a LIMIT 5000 must be lowered to 1000, the warehouse received {sent!r}"
        r = await _run(c, "q3")
        assert r.json().get("row_count") == 10, f"a LIMIT 10 under the cap stays, got {r.json().get('row_count')} rows"
        ctx.grpc.set_latency("Execute", 90.0, config.WAREHOUSE)
        started = ctx.clock.offset
        r = await _run(c, "q1")
        waited = ctx.clock.offset - started
        assert r.status_code == 504, f"a statement past the timeout must answer 504, got {r.status_code}"
        assert waited <= 61, f"the run waited {waited:.0f} s on a 90 s statement: the timeout must end it at 60 s"


async def check_run_signals(ctx):
    finished = GOOD_SQL + " AND status = 'Finished'"
    _seed(ctx, "q1", finished)
    _seed(ctx, "q2")
    async with _api(ctx) as c:
        r = await _run(c, "q1")
        assert r.status_code == 200, f"a query whose filter matches nothing still runs, got {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("row_count") == 0 and body.get("has_output") is False, f"no rows: has_output must be false, got {body.get('has_output')!r} with row_count {body.get('row_count')}"
        stored = _stored(ctx, "q1")
        assert stored.get("status") == "ran" and stored.get("run_ok") is True and stored.get("has_output") is False, f"the record must say ran, run_ok true, has_output false: {stored}"
        r = await _run(c, "q2")
        assert r.json().get("has_output") is True, f"rows came back: has_output must be true, got {r.json().get('has_output')!r}"
        assert _stored(ctx, "q2").get("has_output") is True, f"the record must keep has_output true: {_stored(ctx, 'q2')}"
`,
    typescript: `const GOOD_SQL = "SELECT trip_uuid FROM trips WHERE datestr = '2026-11-01'";

function seed(ctx, queryId = 'q1', sql = GOOD_SQL, acked = ['trips'], user = 'ana') {
  const record = {
    query_id: queryId, user, workspace: 'mobility', question: 'How many trips yesterday?', status: 'generated',
    tables_proposed: acked, tables_acked: acked, sql, run_ok: false, has_output: false,
  };
  ctx.redis.set(\`query:\${queryId}\`, JSON.stringify(record));
}

const stored = (ctx, queryId = 'q1') => JSON.parse(ctx.redis.get(\`query:\${queryId}\`));

function api(ctx) {
  const {sqlagents} = ctx.proto('text_to_sql.proto');
  const config = ctx.load('/support/querygen/config.ts');
  const warehouse = ctx.load('/support/querygen/warehouse.ts');
  ctx.grpc.serve(sqlagents.Warehouse.service, {
    Execute(call, callback) {
      const rows = warehouse.execute(call.request.sql);
      callback(null, {columns: warehouse.COLUMNS, rows: rows.map(values => ({values}))});
    },
  }, config.WAREHOUSE);
  return {c: ctx.client(ctx.load('run_api').app), config};
}

const run = (c, queryId = 'q1', user: string | null = 'ana') => c.post(\`/v1/queries/\${queryId}/run\`, {headers: user ? {'X-User-Id': user} : {}});
const executed = (ctx): string[] => ctx.grpc.callsTo('Execute').map(call => call.request.sql);

async function expectRefused(ctx, c, queryId: string, sql: string, why: string) {
  const before = executed(ctx).length;
  const r = await run(c, queryId);
  assert.equal(r.status, 422, \`\${why}: \${JSON.stringify(sql)} answered \${r.status}, expected 422\`);
  assert.equal(executed(ctx).length, before, \`\${why}: \${JSON.stringify(sql)} reached the warehouse\`);
}

export async function check_route(ctx) {
  seed(ctx);
  const {c} = api(ctx);
  const r = await run(c);
  assert.equal(r.status, 200, \`the owner's run answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.deepStrictEqual(body.columns, ['datestr', 'trip_uuid'], \`the answer carries the warehouse's columns, got \${JSON.stringify(body.columns)}\`);
  assert(Array.isArray(body.rows) && body.row_count === body.rows.length && body.row_count > 0, \`row_count must count the rows returned: \${body.row_count}\`);
  assert.equal((await run(c, 'q1', null)).status, 401, 'without X-User-Id the run must answer 401');
  assert.equal((await run(c, 'nope')).status, 404, 'an unknown query id must answer 404');
  assert.equal((await run(c, 'q1', 'ben')).status, 403, "another user's query must answer 403");
}

export async function check_single_select(ctx) {
  const bad = [
    GOOD_SQL + '; DROP TABLE trips',
    "DELETE FROM trips WHERE datestr = '2026-11-01'",
    "UPDATE trips SET status = 'void' WHERE datestr = '2026-11-01'",
  ];
  bad.forEach((sql, i) => seed(ctx, \`q\${i}\`, sql));
  seed(ctx, 'ok', GOOD_SQL + ';');
  const {c} = api(ctx);
  for (const [i, sql] of bad.entries()) await expectRefused(ctx, c, \`q\${i}\`, sql, 'only one SELECT may run');
  const r = await run(c, 'ok');
  assert.equal(r.status, 200, \`a single SELECT with a trailing semicolon must run, got \${r.status}: \${r.text}\`);
}

export async function check_tables_acked(ctx) {
  const join = "SELECT t.trip_uuid, d.rating FROM trips t JOIN drivers d ON t.driver_uuid = d.driver_uuid WHERE t.datestr = '2026-11-01'";
  seed(ctx, 'q1', join, ['trips']);
  seed(ctx, 'q2', join, ['trips', 'drivers']);
  seed(ctx, 'q3', "SELECT trip_uuid FROM TRIPS WHERE datestr = '2026-11-01'", ['trips']);
  const {c} = api(ctx);
  await expectRefused(ctx, c, 'q1', join, 'drivers was never ACKed');
  let r = await run(c, 'q2');
  assert.equal(r.status, 200, \`with trips and drivers ACKed the join must run, got \${r.status}: \${r.text}\`);
  r = await run(c, 'q3');
  assert.equal(r.status, 200, \`FROM TRIPS names the ACKed table trips (compare case-insensitively), got \${r.status}: \${r.text}\`);
}

export async function check_partition_filter(ctx) {
  seed(ctx, 'q1', "SELECT trip_uuid FROM trips WHERE status = 'completed'");
  seed(ctx, 'q2', 'SELECT trip_uuid FROM trips');
  seed(ctx, 'q3', "SELECT trip_uuid FROM trips WHERE DATESTR >= '2026-10-01'");
  const {c} = api(ctx);
  await expectRefused(ctx, c, 'q1', "SELECT trip_uuid FROM trips WHERE status = 'completed'", 'a WHERE without datestr scans every partition');
  await expectRefused(ctx, c, 'q2', 'SELECT trip_uuid FROM trips', 'no WHERE at all scans every partition');
  const r = await run(c, 'q3');
  assert.equal(r.status, 200, \`a datestr range (any case) is a partition filter, got \${r.status}: \${r.text}\`);
}

export async function check_limit_timeout(ctx) {
  seed(ctx, 'q1');
  seed(ctx, 'q2', GOOD_SQL + ' LIMIT 5000');
  seed(ctx, 'q3', GOOD_SQL + ' LIMIT 10');
  const {c, config} = api(ctx);
  let r = await run(c, 'q1');
  let sent = executed(ctx).at(-1);
  assert(/\\blimit\\s+1000\\s*$/i.test(sent), \`the warehouse received \${JSON.stringify(sent)}: it must end in LIMIT 1000\`);
  assert.equal(r.json().row_count, 1000, \`a capped query returns at most 1000 rows, got \${r.json().row_count}\`);
  const timeout = ctx.grpc.callsTo('Execute').at(-1).timeout;
  assert(timeout !== null && timeout >= 59 && timeout <= 61, \`the Execute call must carry STATEMENT_TIMEOUT_MS = 60 s, got \${timeout}\`);
  await run(c, 'q2');
  sent = executed(ctx).at(-1);
  assert(/\\blimit\\s+1000\\s*$/i.test(sent) && !sent.includes('5000'), \`a LIMIT 5000 must be lowered to 1000, the warehouse received \${JSON.stringify(sent)}\`);
  r = await run(c, 'q3');
  assert.equal(r.json().row_count, 10, \`a LIMIT 10 under the cap stays, got \${r.json().row_count} rows\`);
  ctx.grpc.setLatency('Execute', 90, config.WAREHOUSE);
  const started = ctx.clock.now();
  r = await run(c, 'q1');
  const waited = (ctx.clock.now() - started) / 1000;
  assert.equal(r.status, 504, \`a statement past the timeout must answer 504, got \${r.status}\`);
  assert(waited <= 61, \`the run waited \${waited.toFixed(0)} s on a 90 s statement: the timeout must end it at 60 s\`);
}

export async function check_run_signals(ctx) {
  seed(ctx, 'q1', GOOD_SQL + " AND status = 'Finished'");
  seed(ctx, 'q2');
  const {c} = api(ctx);
  let r = await run(c, 'q1');
  assert.equal(r.status, 200, \`a query whose filter matches nothing still runs, got \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.row_count === 0 && body.has_output === false, \`no rows: has_output must be false, got \${body.has_output} with row_count \${body.row_count}\`);
  const s = stored(ctx, 'q1');
  assert(s.status === 'ran' && s.run_ok === true && s.has_output === false, \`the record must say ran, run_ok true, has_output false: \${JSON.stringify(s)}\`);
  r = await run(c, 'q2');
  assert.equal(r.json().has_output, true, \`rows came back: has_output must be true, got \${r.json().has_output}\`);
  assert.equal(stored(ctx, 'q2').has_output, true, \`the record must keep has_output true: \${JSON.stringify(stored(ctx, 'q2'))}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"querygen/config"
	"querygen/queries"
	warehousedata "querygen/warehouse"
	pb "sqlagents/gen/text_to_sql"

	"leetbuild/harness"
)

const runGoodSQL = "SELECT trip_uuid FROM trips WHERE datestr = '2026-11-01'"

var runLimit1000 = regexp.MustCompile(\`(?i)\\blimit\\s+1000\\s*$\`)

// warehousePeer is the stand-in warehouse: answers from querygen/warehouse.
type warehousePeer struct {
	pb.UnimplementedWarehouseServer
}

func (warehousePeer) Execute(_ context.Context, req *pb.ExecuteRequest) (*pb.ExecuteReply, error) {
	reply := &pb.ExecuteReply{Columns: warehousedata.Columns}
	for _, row := range warehousedata.Execute(req.GetSql()) {
		reply.Rows = append(reply.Rows, &pb.Row{Values: row})
	}
	return reply, nil
}

func runSeed(ctx *harness.Ctx, id, sql string, acked []string) {
	queries.Save(context.Background(), queries.Record{QueryID: id, User: "ana", Workspace: "mobility", Question: "How many trips yesterday?", Status: "generated", TablesProposed: acked, TablesAcked: acked, SQL: sql})
}

func runStored(ctx *harness.Ctx, id string) map[string]any {
	raw, _ := ctx.Redis.Get("query:" + id)
	var rec map[string]any
	json.Unmarshal([]byte(raw), &rec)
	return rec
}

func runClient(ctx *harness.Ctx) *harness.HTTP {
	pb.RegisterWarehouseServer(ctx.GRPC.Server(config.Warehouse), &warehousePeer{})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func runPost(c *harness.HTTP, id, user string) *harness.Response {
	if user == "" {
		return c.Post("/v1/queries/"+id+"/run", nil)
	}
	return c.Post("/v1/queries/"+id+"/run", nil, "X-User-Id", user)
}

func runExecuted(ctx *harness.Ctx) []string {
	var sqls []string
	for _, call := range ctx.GRPC.CallsTo("Execute", "") {
		if req, ok := call.Request.(*pb.ExecuteRequest); ok {
			sqls = append(sqls, req.GetSql())
		}
	}
	return sqls
}

func runBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body
}

func runRefused(ctx *harness.Ctx, c *harness.HTTP, id, sql, why string) {
	before := len(runExecuted(ctx))
	r := runPost(c, id, "ana")
	ctx.Equal(r.Status, 422, "%s: %q", why, sql)
	ctx.Equal(len(runExecuted(ctx)), before, "%s: %q reached the warehouse; warehouse calls", why, sql)
}

func CheckRoute(ctx *harness.Ctx) {
	runSeed(ctx, "q1", runGoodSQL, []string{"trips"})
	c := runClient(ctx)
	r := runPost(c, "q1", "ana")
	ctx.Equal(r.Status, 200, "the owner's run (%s)", r.Text())
	body := runBody(ctx, r)
	ctx.Equal(body["columns"], []any{"datestr", "trip_uuid"}, "the answer carries the warehouse's columns")
	rows, _ := body["rows"].([]any)
	ctx.Assert(len(rows) > 0 && body["row_count"] == float64(len(rows)), "row_count must count the rows returned: %v vs %d", body["row_count"], len(rows))
	ctx.Equal(runPost(c, "q1", "").Status, 401, "without X-User-Id the run")
	ctx.Equal(runPost(c, "nope", "ana").Status, 404, "an unknown query id")
	ctx.Equal(runPost(c, "q1", "ben").Status, 403, "another user's query")
}

func CheckSingleSelect(ctx *harness.Ctx) {
	bad := []string{
		runGoodSQL + "; DROP TABLE trips",
		"DELETE FROM trips WHERE datestr = '2026-11-01'",
		"UPDATE trips SET status = 'void' WHERE datestr = '2026-11-01'",
	}
	for i, sql := range bad {
		runSeed(ctx, "q"+string(rune('0'+i)), sql, []string{"trips"})
	}
	runSeed(ctx, "ok", runGoodSQL+";", []string{"trips"})
	c := runClient(ctx)
	for i, sql := range bad {
		runRefused(ctx, c, "q"+string(rune('0'+i)), sql, "only one SELECT may run")
	}
	r := runPost(c, "ok", "ana")
	ctx.Equal(r.Status, 200, "a single SELECT with a trailing semicolon must run (%s)", r.Text())
}

func CheckTablesAcked(ctx *harness.Ctx) {
	join := "SELECT t.trip_uuid, d.rating FROM trips t JOIN drivers d ON t.driver_uuid = d.driver_uuid WHERE t.datestr = '2026-11-01'"
	runSeed(ctx, "q1", join, []string{"trips"})
	runSeed(ctx, "q2", join, []string{"trips", "drivers"})
	runSeed(ctx, "q3", "SELECT trip_uuid FROM TRIPS WHERE datestr = '2026-11-01'", []string{"trips"})
	c := runClient(ctx)
	runRefused(ctx, c, "q1", join, "drivers was never ACKed")
	r := runPost(c, "q2", "ana")
	ctx.Equal(r.Status, 200, "with trips and drivers ACKed the join must run (%s)", r.Text())
	r = runPost(c, "q3", "ana")
	ctx.Equal(r.Status, 200, "FROM TRIPS names the ACKed table trips (compare case-insensitively) (%s)", r.Text())
}

func CheckPartitionFilter(ctx *harness.Ctx) {
	runSeed(ctx, "q1", "SELECT trip_uuid FROM trips WHERE status = 'completed'", []string{"trips"})
	runSeed(ctx, "q2", "SELECT trip_uuid FROM trips", []string{"trips"})
	runSeed(ctx, "q3", "SELECT trip_uuid FROM trips WHERE DATESTR >= '2026-10-01'", []string{"trips"})
	c := runClient(ctx)
	runRefused(ctx, c, "q1", "SELECT trip_uuid FROM trips WHERE status = 'completed'", "a WHERE without datestr scans every partition")
	runRefused(ctx, c, "q2", "SELECT trip_uuid FROM trips", "no WHERE at all scans every partition")
	r := runPost(c, "q3", "ana")
	ctx.Equal(r.Status, 200, "a datestr range (any case) is a partition filter (%s)", r.Text())
}

func CheckLimitTimeout(ctx *harness.Ctx) {
	runSeed(ctx, "q1", runGoodSQL, []string{"trips"})
	runSeed(ctx, "q2", runGoodSQL+" LIMIT 5000", []string{"trips"})
	runSeed(ctx, "q3", runGoodSQL+" LIMIT 10", []string{"trips"})
	c := runClient(ctx)
	r := runPost(c, "q1", "ana")
	sent := runExecuted(ctx)
	ctx.Assert(len(sent) > 0 && runLimit1000.MatchString(sent[len(sent)-1]), "the warehouse received %v: it must end in LIMIT 1000", sent)
	ctx.Equal(runBody(ctx, r)["row_count"], float64(1000), "a capped query returns at most 1000 rows; row_count")
	calls := ctx.GRPC.CallsTo("Execute", "")
	last := calls[len(calls)-1]
	ctx.Assert(last.HasDeadline() && 59*time.Second <= last.Timeout && last.Timeout <= 61*time.Second, "the Execute call must carry a 60 s statement timeout, got %v", last.Timeout)
	runPost(c, "q2", "ana")
	sent = runExecuted(ctx)
	ctx.Assert(runLimit1000.MatchString(sent[len(sent)-1]) && !strings.Contains(sent[len(sent)-1], "5000"), "a LIMIT 5000 must be lowered to 1000, the warehouse received %q", sent[len(sent)-1])
	r = runPost(c, "q3", "ana")
	ctx.Equal(runBody(ctx, r)["row_count"], float64(10), "a LIMIT 10 under the cap stays; row_count")
	ctx.GRPC.SetLatency("Execute", 90, config.Warehouse)
	started := ctx.Clock.Now()
	r = runPost(c, "q1", "ana")
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Equal(r.Status, 504, "a statement past the timeout")
	ctx.Assert(waited <= 61, "the run waited %.0f s on a 90 s statement: the timeout must end it at 60 s", waited)
}

func CheckRunSignals(ctx *harness.Ctx) {
	runSeed(ctx, "q1", runGoodSQL+" AND status = 'Finished'", []string{"trips"})
	runSeed(ctx, "q2", runGoodSQL, []string{"trips"})
	c := runClient(ctx)
	r := runPost(c, "q1", "ana")
	ctx.Equal(r.Status, 200, "a query whose filter matches nothing still runs (%s)", r.Text())
	body := runBody(ctx, r)
	ctx.Assert(body["row_count"] == float64(0) && body["has_output"] == false, "no rows: has_output must be false, got %v with row_count %v", body["has_output"], body["row_count"])
	stored := runStored(ctx, "q1")
	ctx.Assert(stored["status"] == "ran" && stored["run_ok"] == true && stored["has_output"] == false, "the record must say ran, run_ok true, has_output false: %v", stored)
	r = runPost(c, "q2", "ana")
	ctx.Equal(runBody(ctx, r)["has_output"], true, "rows came back; has_output")
	ctx.Equal(runStored(ctx, "q2")["has_output"], true, "the record must keep has_output true")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <regex>
#include <string>
#include <vector>

#include "querygen/warehouse.h"

namespace {

using json = nlohmann::json;

const std::string kGoodSql = "SELECT trip_uuid FROM trips WHERE datestr = '2026-11-01'";
const std::regex kLimit1000(R"(\\blimit\\s+1000\\s*$)", std::regex::icase);

// The stand-in warehouse: answers from querygen/warehouse.h.
class WarehousePeer final : public sqlagents::Warehouse::Service {
 public:
  grpc::Status Execute(grpc::ServerContext*, const sqlagents::ExecuteRequest* req, sqlagents::ExecuteReply* reply) override {
    for (const auto& c : warehouse::kColumns) reply->add_columns(c);
    for (const auto& row : warehouse::execute(req->sql())) {
      auto* r = reply->add_rows();
      for (const auto& v : row) r->add_values(v);
    }
    return grpc::Status::OK;
  }
};

void seed(harness::Ctx& ctx, const std::string& id, const std::string& sql = kGoodSql, const std::vector<std::string>& acked = {"trips"}) {
  const json record = {{"query_id", id}, {"user", "ana"}, {"workspace", "mobility"}, {"question", "How many trips yesterday?"},
                       {"status", "generated"}, {"tables_proposed", acked}, {"tables_acked", acked}, {"sql", sql},
                       {"run_ok", false}, {"has_output", false}};
  ctx.Redis.Set("query:" + id, record.dump());
}

json stored(harness::Ctx& ctx, const std::string& id) { return json::parse(ctx.Redis.Get("query:" + id).value_or("{}"), nullptr, false); }

struct Api {
  WarehousePeer peer;
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) {
    ctx.GRPC.Server(config::kWarehouse)->RegisterService(&peer);
    register_routes(svr);
  }
  harness::Response run(const std::string& id = "q1", const std::string& user = "ana") {
    if (user.empty()) return http.Post("/v1/queries/" + id + "/run", "");
    return http.Post("/v1/queries/" + id + "/run", "", "X-User-Id", user);
  }
};

Api& api(harness::Ctx& ctx) {
  static Api* current = nullptr;
  delete current;
  current = new Api(ctx);
  return *current;
}

std::vector<std::string> executed(harness::Ctx& ctx) {
  std::vector<std::string> sqls;
  for (const auto& call : ctx.GRPC.CallsTo("Execute")) sqls.push_back(call.Request<sqlagents::ExecuteRequest>().sql());
  return sqls;
}

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the body must be a JSON object: %s", r.Text());
  return body;
}

void refused(harness::Ctx& ctx, Api& a, const std::string& id, const std::string& sql, const std::string& why) {
  const size_t before = executed(ctx).size();
  ctx.Equal(a.run(id).Status, 422, "%s: %q", why, sql);
  ctx.Equal(executed(ctx).size(), before, "%s: %q reached the warehouse; warehouse calls", why, sql);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  seed(ctx, "q1");
  auto& a = api(ctx);
  const auto r = a.run();
  ctx.Equal(r.Status, 200, "the owner's run (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  ctx.Assert(body["columns"] == json({"datestr", "trip_uuid"}), "the answer carries the warehouse's columns: %s", body["columns"].dump());
  ctx.Assert(body["rows"].is_array() && !body["rows"].empty() && body.value("row_count", -1) == static_cast<int>(body["rows"].size()), "row_count must count the rows returned: %s", body.value("row_count", json()).dump());
  ctx.Equal(a.run("q1", "").Status, 401, "without X-User-Id the run");
  ctx.Equal(a.run("nope").Status, 404, "an unknown query id");
  ctx.Equal(a.run("q1", "ben").Status, 403, "another user's query");
}

void CheckSingleSelect(harness::Ctx& ctx) {
  const std::vector<std::string> bad = {kGoodSql + "; DROP TABLE trips", "DELETE FROM trips WHERE datestr = '2026-11-01'",
                                        "UPDATE trips SET status = 'void' WHERE datestr = '2026-11-01'"};
  for (size_t i = 0; i < bad.size(); i++) seed(ctx, "q" + std::to_string(i), bad[i]);
  seed(ctx, "ok", kGoodSql + ";");
  auto& a = api(ctx);
  for (size_t i = 0; i < bad.size(); i++) refused(ctx, a, "q" + std::to_string(i), bad[i], "only one SELECT may run");
  const auto r = a.run("ok");
  ctx.Equal(r.Status, 200, "a single SELECT with a trailing semicolon must run (%s)", r.Text());
}

void CheckTablesAcked(harness::Ctx& ctx) {
  const std::string join = "SELECT t.trip_uuid, d.rating FROM trips t JOIN drivers d ON t.driver_uuid = d.driver_uuid WHERE t.datestr = '2026-11-01'";
  seed(ctx, "q1", join, {"trips"});
  seed(ctx, "q2", join, {"trips", "drivers"});
  seed(ctx, "q3", "SELECT trip_uuid FROM TRIPS WHERE datestr = '2026-11-01'", {"trips"});
  auto& a = api(ctx);
  refused(ctx, a, "q1", join, "drivers was never ACKed");
  auto r = a.run("q2");
  ctx.Equal(r.Status, 200, "with trips and drivers ACKed the join must run (%s)", r.Text());
  r = a.run("q3");
  ctx.Equal(r.Status, 200, "FROM TRIPS names the ACKed table trips (compare case-insensitively) (%s)", r.Text());
}

void CheckPartitionFilter(harness::Ctx& ctx) {
  seed(ctx, "q1", "SELECT trip_uuid FROM trips WHERE status = 'completed'");
  seed(ctx, "q2", "SELECT trip_uuid FROM trips");
  seed(ctx, "q3", "SELECT trip_uuid FROM trips WHERE DATESTR >= '2026-10-01'");
  auto& a = api(ctx);
  refused(ctx, a, "q1", "SELECT trip_uuid FROM trips WHERE status = 'completed'", "a WHERE without datestr scans every partition");
  refused(ctx, a, "q2", "SELECT trip_uuid FROM trips", "no WHERE at all scans every partition");
  const auto r = a.run("q3");
  ctx.Equal(r.Status, 200, "a datestr range (any case) is a partition filter (%s)", r.Text());
}

void CheckLimitTimeout(harness::Ctx& ctx) {
  seed(ctx, "q1");
  seed(ctx, "q2", kGoodSql + " LIMIT 5000");
  seed(ctx, "q3", kGoodSql + " LIMIT 10");
  auto& a = api(ctx);
  auto r = a.run("q1");
  auto sent = executed(ctx);
  ctx.Assert(!sent.empty() && std::regex_search(sent.back(), kLimit1000), "the warehouse received %v: it must end in LIMIT 1000", sent);
  ctx.Equal(bodyOf(ctx, r).value("row_count", -1), 1000, "a capped query returns at most 1000 rows; row_count");
  const auto last = ctx.GRPC.CallsTo("Execute").back();
  ctx.Assert(last.HasDeadline() && 59 <= last.TimeoutSeconds() && last.TimeoutSeconds() <= 61, "the Execute call must carry a 60 s statement timeout, got %vs", last.TimeoutSeconds());
  a.run("q2");
  sent = executed(ctx);
  ctx.Assert(std::regex_search(sent.back(), kLimit1000) && sent.back().find("5000") == std::string::npos, "a LIMIT 5000 must be lowered to 1000, the warehouse received %q", sent.back());
  r = a.run("q3");
  ctx.Equal(bodyOf(ctx, r).value("row_count", -1), 10, "a LIMIT 10 under the cap stays; row_count");
  ctx.GRPC.SetLatency("Execute", 90, config::kWarehouse);
  const int64_t started = ctx.Clock.Now();
  r = a.run("q1");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Equal(r.Status, 504, "a statement past the timeout");
  ctx.Assert(waited <= 61, "the run waited %.0f s on a 90 s statement: the timeout must end it at 60 s", waited);
}

void CheckRunSignals(harness::Ctx& ctx) {
  seed(ctx, "q1", kGoodSql + " AND status = 'Finished'");
  seed(ctx, "q2");
  auto& a = api(ctx);
  auto r = a.run("q1");
  ctx.Equal(r.Status, 200, "a query whose filter matches nothing still runs (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  ctx.Assert(body.value("row_count", -1) == 0 && body.contains("has_output") && body["has_output"] == false, "no rows: has_output must be false: %s", r.Text());
  const json s = stored(ctx, "q1");
  ctx.Assert(s.value("status", "") == "ran" && s.value("run_ok", false) == true && s.value("has_output", true) == false, "the record must say ran, run_ok true, has_output false: %s", s.dump());
  r = a.run("q2");
  const json second = bodyOf(ctx, r);
  ctx.Assert(second.contains("has_output") && second["has_output"] == true, "rows came back: has_output must be true: %s", r.Text().substr(0, 120));
  ctx.Assert(stored(ctx, "q2").value("has_output", false) == true, "the record must keep has_output true: %s", stored(ctx, "q2").dump());
}
`,
  },
  hints: [
    'Symptom: a DELETE the model wrote runs, a join on a table nobody ACKed reaches the warehouse, a question with no date scans a year of partitions, a browser tab receives every row, and an empty result looks the same as a good one.',
    'Mechanism: between `store.get` and `Execute` nothing reads the SQL; the call has no timeout and no `LIMIT` is added; the handler saves `run_ok` but never counts the rows into `has_output`.',
    'Change: `is_single_select`, `referenced_tables` against lower-cased `tables_acked`, `has_partition_filter` on `PARTITION_COLUMN`, 422 at the first failure; `Execute(with_limit(sql), timeout=STATEMENT_TIMEOUT_S)`, 504 on `DEADLINE_EXCEEDED`; save and answer `has_output = len(rows) > 0`.',
  ],
  debrief: `Every guard is a cheap check that turns a warehouse incident into a 422 the user can read. The order runs from structure to cost: one statement before anything else, then the tables the user agreed to, then the partition filter that decides whether the scan is one day or every day, then the row cap and timeout that bound what still gets through. \`has_output\` exists because "it ran" and "it answered" are different facts: QueryGPT tracks them apart since a hallucinated filter runs cleanly and returns nothing. Regular expressions miss comma joins and CTE names; production guards parse the SQL into a tree and often add a dry-run \`EXPLAIN\` with a cost ceiling before the real run.`,
};
