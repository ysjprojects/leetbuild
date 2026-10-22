import type {Step} from '@/lib/types';

export const subscriptionEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/subscriptions: only tables a tenant may stream',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'pg'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the subscription
route, parses the body, runs the caller's filter against the source database and returns a record.
It compiles, it serves the demo, and it hides three production flaws. Review it like the service
owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/subscriptions\` with body \`{"table": "orders", "filter": "status = 'paid'", "sink": "warehouse-1"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`table\` must be on the tenant's approved list (the catalog's \`APPROVED_TABLES\`). A table that is
  not approved — \`auth_users\`, \`sessions\`, another tenant's table — is **403**, returned before any
  replication or source query starts. Never treat "the table exists in the database" as permission.
- \`filter\` is a \`"column op literal" && "column op literal"\` string (clauses joined by \` AND \`,
  operators \`= != < <= > >=\` or \`in\`) and defaults to the empty string, meaning "every change".
  Parse it into structured predicates and reject (**400**) anything that is not a
  \`column op literal\` clause. A column in \`SENSITIVE_COLUMNS\` is **400** too: a subscription may
  filter on allowed columns only, so a tenant cannot route \`email\` or \`ssn\` into a sink.
- Compile the predicates into SQL with placeholders (\`buildPredicate\`); the caller's filter text is
  never interpolated into the statement the source database executes.
- \`sink\` is a non-empty string (**400** otherwise).
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(tenant, key)\`
  returns the **existing** subscription — same \`id\` — instead of creating a second stream.
- Log the created subscription id, tenant, table and sink — never the filter text.

**Failure mode the checks target.** Approval is a catalog decision, not an existence check: the draft
streams \`auth_users\` and \`sessions\` because they are rows in the same database, which turns a
tenant's subscription into an exfiltration path for every other tenant's credentials. The filter is
the second defect: \`WHERE {filter}\` is tenant-authored SQL evaluated with the replication
credentials, so a crafted clause reads columns the subscription is not allowed to name. The missing
idempotency key is the quiet third one — a client retry after a timeout creates two streams over the
same table, two slots, two WAL readers and two copies of every change in the sink.`,
  sequence: {
    participants: ['Client', 'CDC API', 'catalog', 'subscription store'],
    messages: [
      {
        from: 'Client',
        to: 'CDC API',
        label: 'POST /v1/subscriptions · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'CDC API', to: 'catalog', label: 'approved_tables(tenant) · sensitive columns', kind: 'sync'},
      {from: 'catalog', to: 'CDC API', label: 'approved tables / not approved', kind: 'reply'},
      {from: 'CDC API', to: 'CDC API', label: 'parse filter · compile predicates', kind: 'sync'},
      {from: 'CDC API', to: 'subscription store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'subscription store', to: 'CDC API', label: 'existing subscription / none', kind: 'reply'},
      {from: 'CDC API', to: 'subscription store', label: 'put(tenant, idem_key, subscription)', kind: 'async'},
      {from: 'CDC API', to: 'Client', label: '200 subscription · 403 unapproved table', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/subscriptions',
      detail: 'Register the subscription route on `POST /v1/subscriptions`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/subscriptions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/subscriptions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/subscriptions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"subscriptions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/subscriptions"/]},
      },
    },
    {
      id: 'approved-table',
      title: 'Refuses an unapproved table with 403 before replication',
      detail:
        'The table is checked against the tenant’s approved list (`APPROVED_TABLES`, `approvedTable`) and an unapproved one is **403** — decided before any slot, replication or source query. The draft streams whatever table exists in the database, `auth_users` included.',
      match: {
        python: {all: [/APPROVED_TABLES/, /def approved_table\(/, /status_code\s*=\s*403/]},
        typescript: {all: [/APPROVED_TABLES/, /function approvedTable\(/, /code\(\s*403\s*\)/]},
        go: {all: [/approvedTables/, /func approvedTable\(/, /http\.StatusForbidden/]},
        scala: {all: [/ApprovedTables/, /def approvedTable\(/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/kApprovedTables/, /approvedTable\(/, /\b403\b/]},
      },
    },
    {
      id: 'filter-columns',
      title: 'Parses the filter and rejects sensitive columns',
      detail:
        '`parseFilter` turns the filter into structured predicates and anything that is not a `column op literal` clause is **400**; a column in `SENSITIVE_COLUMNS` is **400** as well. The draft forwards the raw string and lets the source database decide what it means.',
      match: {
        python: {all: [/SENSITIVE_COLUMNS/, /def parse_filter\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/SENSITIVE_COLUMNS/, /function parseFilter\(/, /code\(\s*400\s*\)/]},
        go: {all: [/sensitiveColumns/, /func parseFilter\(/, /http\.StatusBadRequest/]},
        scala: {all: [/SensitiveColumns/, /def parseFilter\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kSensitiveColumns/, /parseFilter\(/, /\b400\b/]},
      },
    },
    {
      id: 'idempotent-create',
      title: 'Keys the create by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the subscription is stored under `(tenant, key)`; a replay returns the stored subscription instead of creating a second stream. The draft ignores the header, so a client retry opens a second slot over the same table.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'no-raw-filter',
      title: 'Compiles predicates instead of interpolating the filter',
      detail:
        'The validated predicates are rendered into SQL with placeholders by `buildPredicate`; the caller’s filter text never reaches the statement. The draft builds `WHERE {filter}` and runs it with the replication credentials.',
      match: {
        python: {all: [/def build_predicate\(/, /placeholders/], none: [/run_source_query\(/]},
        typescript: {all: [/function buildPredicate\(/, /placeholders/], none: [/runSourceQuery\(/]},
        go: {all: [/func buildPredicate\(/, /placeholders/], none: [/runSourceQuery\(/]},
        scala: {all: [/def buildPredicate\(/, /placeholders/], none: [/runSourceQuery\(/]},
        cpp: {all: [/buildPredicate\(/, /placeholders/], none: [/runSourceQuery\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("cdc")

STREAMABLE_TABLES = ["orders", "customers", "invoices", "auth_users", "sessions"]


class SubscriptionRequest(BaseModel):
    table: str
    filter: str = ""
    sink: str


def run_source_query(sql: str) -> int:
    """Run the generated SQL against the source database and return the matched row count."""
    raise NotImplementedError


@app.post("/v1/subscriptions")
def create_subscription(body: SubscriptionRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft streams any table in STREAMABLE_TABLES — auth_users and sessions included —
    # interpolates the caller's filter straight into the SQL it runs with replication credentials,
    # and ignores Idempotency-Key. Review all three.
    sql = f"SELECT count(*) FROM {body.table} WHERE {body.filter}"
    rows = run_source_query(sql)
    logger.info("subscription tenant=%s table=%s filter=%s", tenant, body.table, body.filter)
    return JSONResponse(
        {"table": body.table, "filter": body.filter, "sink": body.sink, "rows": rows}, status_code=200
    )
`,
      solution: `import logging
import re
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("cdc")

APPROVED_TABLES = {
    "acme": {"orders", "customers", "invoices"},
    "globex": {"orders", "invoices"},
}
SENSITIVE_COLUMNS = {"email", "ssn", "card_number", "password_hash"}
CLAUSE = re.compile(r"^([a-z_][a-z0-9_]*)\\s*(=|!=|<=|>=|<|>|in)\\s*(.+)$")
OPERATORS = {"=", "!=", "<", "<=", ">", ">=", "in"}


class SubscriptionRequest(BaseModel):
    table: str
    filter: str = ""
    sink: str


class SubscriptionStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The subscription stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, subscription: dict) -> None:
        """Store the subscription under (tenant, idem_key)."""
        raise NotImplementedError


store = SubscriptionStore()


def approved_table(tenant: str, table: str) -> bool:
    """Whether the tenant's catalog approves streaming this table."""
    return table in APPROVED_TABLES.get(tenant, set())


def parse_filter(filter_text: str) -> list[tuple[str, str, str]]:
    """Parse 'col op literal' clauses joined by AND into structured predicates, raising otherwise."""
    if filter_text.strip() == "":
        return []
    predicates: list[tuple[str, str, str]] = []
    for clause in filter_text.split(" AND "):
        match = CLAUSE.match(clause.strip())
        if match is None or match.group(2) not in OPERATORS:
            raise ValueError("filter must be column op literal clauses joined by AND")
        column, op, literal = match.group(1), match.group(2), match.group(3)
        if column in SENSITIVE_COLUMNS:
            raise ValueError(f"column {column} is not streamable")
        predicates.append((column, op, literal))
    return predicates


def build_predicate(table: str, predicates: list[tuple[str, str, str]]) -> tuple[str, list[str]]:
    """Compile the validated predicates into SQL placeholders — never the caller's text."""
    if not predicates:
        return f'SELECT * FROM "{table}"', []
    placeholders = ["%s"] * len(predicates)
    clauses = [
        f'"{column}" {op.upper()} {placeholder}'
        for (column, op, _), placeholder in zip(predicates, placeholders)
    ]
    return f'SELECT * FROM "{table}" WHERE ' + " AND ".join(clauses), [literal for _, _, literal in predicates]


@app.post("/v1/subscriptions")
def create_subscription(
    body: SubscriptionRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.sink == "":
        raise HTTPException(status_code=400, detail="sink is required")
    if not approved_table(tenant, body.table):
        raise HTTPException(status_code=403, detail=f"table {body.table} is not on the tenant's approved list")
    try:
        predicates = parse_filter(body.filter)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    existing = store.get(tenant, idem_key)
    if existing is not None:
        return JSONResponse(existing, status_code=200)

    sql, params = build_predicate(body.table, predicates)
    subscription = {
        "id": str(uuid.uuid4()),
        "tenant": tenant,
        "table": body.table,
        "filter": body.filter,
        "sink": body.sink,
        "sql": sql,
        "params": params,
        "state": "created",
    }
    store.put(tenant, idem_key, subscription)
    logger.info(
        "subscription created id=%s tenant=%s table=%s sink=%s",
        subscription["id"],
        tenant,
        body.table,
        body.sink,
    )
    return JSONResponse(subscription, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/subscriptions: a model-generated draft that streams whatever the caller names. */
import Fastify from 'fastify';

export const app = Fastify();

const STREAMABLE_TABLES = ['orders', 'customers', 'invoices', 'auth_users', 'sessions'];

interface SubscriptionBody {
  table: string;
  filter?: string;
  sink: string;
}

async function runSourceQuery(sql: string): Promise<number> {
  /** Run the generated SQL against the source database and return the matched row count. */
  throw new Error('not implemented');
}

app.post('/v1/subscriptions', async (request, reply) => {
  // TODO: this draft streams any table in STREAMABLE_TABLES — auth_users and sessions included —
  // interpolates the caller's filter straight into the SQL it runs with replication credentials,
  // and ignores Idempotency-Key. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as SubscriptionBody;
  const sql = \`SELECT count(*) FROM \${body.table} WHERE \${body.filter ?? 'true'}\`;
  const rows = await runSourceQuery(sql);
  request.log.info({tenant, table: body.table, filter: body.filter}, 'subscription');
  return reply.code(200).send({table: body.table, filter: body.filter, sink: body.sink, rows});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/subscriptions: only tables a tenant may stream, with a filter on allowed columns. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store, type Subscription} from './store';

export const app = Fastify();

const APPROVED_TABLES: Record<string, string[]> = {
  acme: ['orders', 'customers', 'invoices'],
  globex: ['orders', 'invoices'],
};
const SENSITIVE_COLUMNS = new Set(['email', 'ssn', 'card_number', 'password_hash']);
const CLAUSE = /^([a-z_][a-z0-9_]*)\\s*(=|!=|<=|>=|<|>|in)\\s*(.+)$/;

interface SubscriptionBody {
  table: string;
  filter?: string;
  sink: string;
}

interface Predicate {
  column: string;
  op: string;
  literal: string;
}

function approvedTable(tenant: string, table: string): boolean {
  /** Whether the tenant's catalog approves streaming this table. */
  return (APPROVED_TABLES[tenant] ?? []).includes(table);
}

function parseFilter(filter: string): Predicate[] {
  if (filter.trim() === '') return [];
  return filter.split(' AND ').map(clause => {
    const match = CLAUSE.exec(clause.trim());
    if (match === null) throw new Error('filter must be column op literal clauses joined by AND');
    const [, column, op, literal] = match;
    if (SENSITIVE_COLUMNS.has(column)) throw new Error(\`column \${column} is not streamable\`);
    return {column, op, literal};
  });
}

function buildPredicate(table: string, predicates: Predicate[]): {sql: string; params: string[]} {
  if (predicates.length === 0) return {sql: \`SELECT * FROM "\${table}"\`, params: []};
  const placeholders = predicates.map(() => '$1');
  const clauses = predicates.map((p, i) => \`"\${p.column}" \${p.op.toUpperCase()} \${placeholders[i]}\`);
  return {sql: \`SELECT * FROM "\${table}" WHERE \${clauses.join(' AND ')}\`, params: predicates.map(p => p.literal)};
}

app.post('/v1/subscriptions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<SubscriptionBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.table !== 'string' || typeof body.sink !== 'string')
    return reply.code(400).send({error: 'table and sink are required'});
  if (body.sink === '') return reply.code(400).send({error: 'sink is required'});
  if (!approvedTable(tenant, body.table))
    return reply.code(403).send({error: \`table \${body.table} is not on the tenant's approved list\`});

  let predicates: Predicate[];
  try {
    predicates = parseFilter(body.filter ?? '');
  } catch (error) {
    return reply.code(400).send({error: (error as Error).message});
  }

  const existing: Subscription | null = await store.get(tenant, idemKey);
  if (existing !== null) return reply.code(200).send(existing);

  const {sql, params} = buildPredicate(body.table, predicates);
  const subscription: Subscription = {
    id: randomUUID(),
    tenant,
    table: body.table,
    filter: body.filter ?? '',
    sink: body.sink,
    sql,
    params,
    state: 'created',
  };
  await store.put(tenant, idemKey, subscription);
  request.log.info({tenant, id: subscription.id, table: body.table, sink: body.sink}, 'subscription created');
  return reply.code(200).send(subscription);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

var streamableTables = map[string]bool{
	"orders":     true,
	"customers":  true,
	"invoices":   true,
	"auth_users": true,
	"sessions":   true,
}

type SubscriptionRequest struct {
	Table  string \`json:"table"\`
	Filter string \`json:"filter"\`
	Sink   string \`json:"sink"\`
}

type SubscriptionStore struct{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func runSourceQuery(sql string) (int, error) {
	return 0, nil
}

func createSubscription(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body SubscriptionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft streams any table in streamableTables — auth_users and sessions included —
	// interpolates the caller's filter straight into the SQL it runs with replication credentials,
	// and ignores Idempotency-Key. Review all three.
	sql := fmt.Sprintf("SELECT count(*) FROM %s WHERE %s", body.Table, body.Filter)
	rows, _ := runSourceQuery(sql)
	log.Printf("subscription tenant=%s table=%s filter=%s", tenant, body.Table, body.Filter)
	writeJSON(rw, http.StatusOK, map[string]any{
		"table":  body.Table,
		"filter": body.Filter,
		"sink":   body.Sink,
		"rows":   rows,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/subscriptions", createSubscription)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

var approvedTables = map[string]map[string]bool{
	"acme":   {"orders": true, "customers": true, "invoices": true},
	"globex": {"orders": true, "invoices": true},
}

var sensitiveColumns = map[string]bool{
	"email":         true,
	"ssn":           true,
	"card_number":   true,
	"password_hash": true,
}

var operators = map[string]bool{"=": true, "!=": true, "<": true, "<=": true, ">": true, ">=": true, "in": true}

type SubscriptionRequest struct {
	Table  string \`json:"table"\`
	Filter string \`json:"filter"\`
	Sink   string \`json:"sink"\`
}

type Predicate struct {
	Column  string \`json:"column"\`
	Op      string \`json:"op"\`
	Literal string \`json:"literal"\`
}

type Subscription struct {
	ID     string   \`json:"id"\`
	Tenant string   \`json:"tenant"\`
	Table  string   \`json:"table"\`
	Filter string   \`json:"filter"\`
	Sink   string   \`json:"sink"\`
	SQL    string   \`json:"sql"\`
	Params []string \`json:"params"\`
	State  string   \`json:"state"\`
}

type SubscriptionStore struct{}

func (s *SubscriptionStore) Get(ctx context.Context, tenant, idemKey string) (*Subscription, error) {
	return nil, nil
}

func (s *SubscriptionStore) Put(ctx context.Context, tenant, idemKey string, sub *Subscription) error {
	return nil
}

var store = &SubscriptionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func approvedTable(tenant, table string) bool {
	/** Whether the tenant's catalog approves streaming this table. */
	return approvedTables[tenant][table]
}

func parseFilter(filter string) ([]Predicate, error) {
	if strings.TrimSpace(filter) == "" {
		return nil, nil
	}
	predicates := make([]Predicate, 0, 4)
	for _, clause := range strings.Split(filter, " AND ") {
		parts := strings.Fields(clause)
		if len(parts) < 3 || !operators[parts[1]] {
			return nil, fmt.Errorf("filter must be column op literal clauses joined by AND")
		}
		column := parts[0]
		if sensitiveColumns[column] {
			return nil, fmt.Errorf("column %s is not streamable", column)
		}
		predicates = append(predicates, Predicate{
			Column:  column,
			Op:      parts[1],
			Literal: strings.Trim(strings.Join(parts[2:], " "), "'"),
		})
	}
	return predicates, nil
}

func buildPredicate(table string, predicates []Predicate) (string, []string) {
	/** Compile the validated predicates into SQL placeholders — never the caller's text. */
	if len(predicates) == 0 {
		return fmt.Sprintf(\`SELECT * FROM "%s"\`, table), nil
	}
	placeholders := make([]string, len(predicates))
	params := make([]string, len(predicates))
	clauses := make([]string, len(predicates))
	for i, p := range predicates {
		placeholders[i] = "$1"
		params[i] = p.Literal
		clauses[i] = fmt.Sprintf(\`"%s" %s %s\`, p.Column, strings.ToUpper(p.Op), placeholders[i])
	}
	return fmt.Sprintf(\`SELECT * FROM "%s" WHERE %s\`, table, strings.Join(clauses, " AND ")), params
}

func createSubscription(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body SubscriptionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Sink == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "sink is required"})
		return
	}
	if !approvedTable(tenant, body.Table) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "table is not on the tenant's approved list"})
		return
	}
	predicates, err := parseFilter(body.Filter)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	existing, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		writeJSON(rw, http.StatusOK, existing)
		return
	}
	sql, params := buildPredicate(body.Table, predicates)
	sub := &Subscription{
		ID:     uuid.NewString(),
		Tenant: tenant,
		Table:  body.Table,
		Filter: body.Filter,
		Sink:   body.Sink,
		SQL:    sql,
		Params: params,
		State:  "created",
	}
	if err := store.Put(r.Context(), tenant, idemKey, sub); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("subscription created id=%s tenant=%s table=%s sink=%s", sub.ID, tenant, body.Table, body.Sink)
	writeJSON(rw, http.StatusOK, sub)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/subscriptions", createSubscription)
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

final case class SubscriptionRequest(table: String, filter: String, sink: String)

object CdcApi {
  implicit val system: ActorSystem = ActorSystem("cdc-streamer")
  implicit val requestFormat: RootJsonFormat[SubscriptionRequest] = jsonFormat3(SubscriptionRequest)

  val StreamableTables = Set("orders", "customers", "invoices", "auth_users", "sessions")

  def runSourceQuery(sql: String): Long = 0L

  val route: Route =
    path("v1" / "subscriptions") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[SubscriptionRequest]) { body =>
            // TODO: this draft streams any table in StreamableTables — auth_users and sessions
            // included — interpolates the caller's filter straight into the SQL it runs with
            // replication credentials, and ignores Idempotency-Key. Review all three.
            val sql = s"SELECT count(*) FROM \${body.table} WHERE \${body.filter}"
            val rows = runSourceQuery(sql)
            system.log.info(s"subscription tenant=$tenant table=\${body.table} filter=\${body.filter}")
            complete(StatusCodes.OK, s"""{"table":"\${body.table}","rows":$rows}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SubscriptionRequest(table: String, filter: String, sink: String)
final case class Predicate(column: String, op: String, literal: String)
final case class Subscription(
    id: String,
    tenant: String,
    table: String,
    filter: String,
    sink: String,
    sql: String,
    params: List[String],
    state: String,
)

object CdcApi {
  implicit val system: ActorSystem = ActorSystem("cdc-streamer")
  implicit val requestFormat: RootJsonFormat[SubscriptionRequest] = jsonFormat3(SubscriptionRequest)
  implicit val predicateFormat: RootJsonFormat[Predicate] = jsonFormat3(Predicate)
  implicit val subscriptionFormat: RootJsonFormat[Subscription] = jsonFormat8(Subscription)

  val ApprovedTables: Map[String, Set[String]] =
    Map("acme" -> Set("orders", "customers", "invoices"), "globex" -> Set("orders", "invoices"))
  val SensitiveColumns: Set[String] = Set("email", "ssn", "card_number", "password_hash")
  val Operators: Set[String] = Set("=", "!=", "<", "<=", ">", ">=", "in")

  val store = SubscriptionStore.open()

  def approvedTable(tenant: String, table: String): Boolean =
    ApprovedTables.getOrElse(tenant, Set.empty).contains(table)

  def parseFilter(filter: String): List[Predicate] =
    if (filter.trim.isEmpty) Nil
    else
      filter.split(" AND ").toList.map { clause =>
        val parts = clause.trim.split("\\\\s+")
        if (parts.length < 3 || !Operators.contains(parts(1))) {
          throw new IllegalArgumentException("filter must be column op literal clauses joined by AND")
        }
        if (SensitiveColumns.contains(parts(0))) {
          throw new IllegalArgumentException(s"column \${parts(0)} is not streamable")
        }
        Predicate(parts(0), parts(1), parts.drop(2).mkString(" ").stripPrefix("'").stripSuffix("'"))
      }

  def buildPredicate(table: String, predicates: List[Predicate]): (String, List[String]) = {
    if (predicates.isEmpty) return (s"""SELECT * FROM $table""", Nil)
    val placeholders = predicates.map(_ => "$1")
    val clauses = predicates.zip(placeholders).map { case (p, placeholder) =>
      s"\${p.column} \${p.op.toUpperCase} $placeholder"
    }
    (s"""SELECT * FROM $table WHERE \${clauses.mkString(" AND ")}""", predicates.map(_.literal))
  }

  val route: Route =
    path("v1" / "subscriptions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[SubscriptionRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.sink.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"sink is required"}""")
              } else if (!approvedTable(tenantOpt.get, body.table)) {
                complete(StatusCodes.Forbidden, """{"error":"table is not on the tenant's approved list"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                try {
                  val predicates = parseFilter(body.filter)
                  store.get(tenant, idemKey) match {
                    case Some(stored) =>
                      complete(StatusCodes.OK, stored)
                    case None =>
                      val (sql, params) = buildPredicate(body.table, predicates)
                      val sub = Subscription(
                        UUID.randomUUID().toString,
                        tenant,
                        body.table,
                        body.filter,
                        body.sink,
                        sql,
                        params,
                        "created",
                      )
                      store.put(tenant, idemKey, sub)
                      system.log.info(s"subscription created id=\${sub.id} tenant=$tenant table=\${body.table}")
                      complete(StatusCodes.OK, sub)
                  }
                } catch {
                  case error: IllegalArgumentException =>
                    complete(StatusCodes.BadRequest, s"""{"error":"\${error.getMessage}"}""")
                }
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

#include <iostream>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kStreamableTables = {"orders", "customers", "invoices", "auth_users", "sessions"};

long runSourceQuery(const std::string& sql) { return 0; }

int main() {
  httplib::Server svr;

  svr.Post("/v1/subscriptions", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft streams any table in kStreamableTables — auth_users and sessions included —
    // interpolates the caller's filter straight into the SQL it runs with replication credentials,
    // and ignores Idempotency-Key. Review all three.
    const auto table = body.value("table", std::string());
    const auto filter = body.value("filter", std::string());
    if (kStreamableTables.count(table) == 0) {
      res.status = 404;
      res.set_content(R"({"error":"unknown table"})", "application/json");
      return;
    }
    const auto sql = "SELECT count(*) FROM " + table + " WHERE " + filter;
    const long rows = runSourceQuery(sql);
    std::cerr << "subscription tenant=" << tenant << " table=" << table << " filter=" << filter << "\\n";
    res.status = 200;
    res.set_content(json{{"table", table}, {"rows", rows}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::map<std::string, std::set<std::string>> kApprovedTables = {
    {"acme", {"orders", "customers", "invoices"}},
    {"globex", {"orders", "invoices"}},
};
const std::set<std::string> kSensitiveColumns = {"email", "ssn", "card_number", "password_hash"};

struct Predicate {
  std::string column;
  std::string op;
  std::string literal;
};

struct Subscription {
  std::string id;
  std::string tenant;
  std::string table;
  std::string filter;
  std::string sink;
  std::string sql;
  std::vector<std::string> params;
  std::string state;
};

struct SubscriptionStore {
  std::optional<Subscription> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const Subscription& sub);
};

SubscriptionStore store;
std::string uuidString();
std::vector<std::string> splitOnAnd(const std::string& filter);

bool approvedTable(const std::string& tenant, const std::string& table) {
  /** Whether the tenant's catalog approves streaming this table. */
  const auto it = kApprovedTables.find(tenant);
  return it != kApprovedTables.end() && it->second.count(table) > 0;
}

std::vector<Predicate> parseFilter(const std::string& filter) {
  std::vector<Predicate> predicates;
  if (filter.empty()) return predicates;
  for (const auto& clause : splitOnAnd(filter)) {
    const auto first = clause.find(' ');
    const auto second = clause.find(' ', first + 1);
    if (first == std::string::npos || second == std::string::npos) {
      throw std::invalid_argument("filter must be column op literal clauses joined by AND");
    }
    const auto column = clause.substr(0, first);
    const auto op = clause.substr(first + 1, second - first - 1);
    if (kSensitiveColumns.count(column) > 0) {
      throw std::invalid_argument("column " + column + " is not streamable");
    }
    predicates.push_back(Predicate{column, op, clause.substr(second + 1)});
  }
  return predicates;
}

std::pair<std::string, std::vector<std::string>> buildPredicate(
    const std::string& table, const std::vector<Predicate>& predicates) {
  /** Compile the validated predicates into SQL placeholders — never the caller's text. */
  if (predicates.empty()) return {"SELECT * FROM \\"" + table + "\\"", {}};
  const std::vector<std::string> placeholders(predicates.size(), "$1");
  std::string sql = "SELECT * FROM \\"" + table + "\\" WHERE ";
  std::vector<std::string> params;
  for (std::size_t i = 0; i < predicates.size(); ++i) {
    if (i > 0) sql += " AND ";
    sql += "\\"" + predicates[i].column + "\\" " + predicates[i].op + " " + placeholders[i];
    params.push_back(predicates[i].literal);
  }
  return {sql, params};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/subscriptions", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto table = body.value("table", std::string());
    const auto filter = body.value("filter", std::string());
    const auto sink = body.value("sink", std::string());
    if (sink.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"sink is required"})", "application/json");
      return;
    }
    if (!approvedTable(tenant, table)) {
      res.status = 403;
      res.set_content(R"({"error":"table is not on the tenant's approved list"})", "application/json");
      return;
    }
    std::vector<Predicate> predicates;
    try {
      predicates = parseFilter(filter);
    } catch (const std::invalid_argument& error) {
      res.status = 400;
      res.set_content(json{{"error", error.what()}}.dump(), "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(json{{"id", stored->id}, {"table", stored->table}, {"sink", stored->sink}}.dump(),
                      "application/json");
      return;
    }
    const auto [sql, params] = buildPredicate(table, predicates);
    const Subscription sub{uuidString(), tenant, table, filter, sink, sql, params, "created"};
    store.put(tenant, idemKey, sub);
    std::cerr << "subscription created id=" << sub.id << " tenant=" << tenant << " table=" << table
              << " sink=" << sink << "\\n";
    res.status = 200;
    res.set_content(json{{"id", sub.id}, {"table", sub.table}, {"sql", sub.sql}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
  return 0;
}
`,
    },
  },
  hints: [
    'Write the guards in cost order: tenant (401), Idempotency-Key (400), sink, table approval (403), then the filter. Approval is a catalog lookup, not a `SELECT 1 FROM information_schema` probe — the source database describes every tenant’s data, and only your catalog describes this tenant’s subscription.',
    'A filter is not a string to forward: split it on ` AND `, match each clause against `column op literal`, and check the column against the allowed set. Then render the predicates with placeholders, so `buildPredicate` produces the SQL and the caller only ever supplies values.',
    'Idempotency is keyed by `(tenant, Idempotency-Key)` and checked before the subscription is written; a hit returns the stored record, id included, with 200. Without it a client retry after a timeout opens a second slot, a second reader and a second copy of every change in the sink.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler that has database credentials in its hand. The draft reads fine because the demo subscribes to \`orders\` from a tenant whose whole database is that tenant's. Three defects are being checked. Authorization is a catalog decision: \`auth_users\` is a table in the same database, and "the table exists" is not "this tenant may stream it" — the refusal must be 403 and must happen before a slot exists. The filter is the second one, and it is the one candidates skip: an arbitrary filter string is tenant-authored SQL executed with replication credentials, so parsing it to structured predicates over non-sensitive columns is the difference between a stream and a database client. The third is idempotency: creating a subscription is a replication side effect, and a retried create must return the subscription it already has. Real streamers add per-table column allow-lists, a filter AST stored beside the subscription, and a hard cap on subscriptions per tenant.`,
};
