package pq

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"sync"
)

// Backend is the database behind the driver. The host implements it over the JavaScript Db
// (src/lib/runtime/ts/pg.ts): one PGlite session, shared with the TypeScript runtime, behind the
// Db's single-connection lock (withConnection). Not part of lib/pq's API.
//
// Hold — Db.withConnection: block until the connection is free, take it, and return release,
// which gives it back (called exactly once). A transaction holds the connection from its BEGIN to
// its COMMIT/ROLLBACK; every statement in between arrives with Held set. ctx may end the wait:
// then return ctx.Err() and, if the lock is acquired later anyway, give it back at once.
//
// Run — Db.run(sql, params, held, counted), extended to return typed rows:
//   - Held false: take the lock for this statement alone (autocommit); true: the caller holds it.
//   - Counted: the learner's statement (Db.learnerStatements += 1, the sqlStatements metric);
//     false for the harness's own statements.
//   - Args, in $n order, each one of:
//     nil       → NULL;
//     string    → the value in Postgres text format ("42", "3.5", "true", "2026-01-02
//     15:04:05.123Z", "{\"a\",\"b\"}" for arrays …), passed through untouched;
//     []byte    → raw bytes, sent the way lib/pq sends byte slices (binary format): into a bytea
//     parameter as those bytes ("\x<hex>" in text format), into any other type (text, json …)
//     as the bytes read as UTF-8 text.
//     With PGlite: `pg.query(sql, args, {rowMode: 'array', parsers: RAW, serializers: SER})`
//     where SER is `new Proxy({}, {get: (_, oid) => v => typeof v === 'string' ? v : oid ===
//     '17' ? '\\x' + hex(v) : new TextDecoder().decode(v)})` (PGlite looks serializers up by
//     key, so a Proxy works) and RAW maps every key of `pg.parsers` (after waitReady: it includes
//     the array types) to `x => x` (PGlite spreads parsers, so a Proxy does not work; types it
//     has no parser for already come back as text).
//   - Several statements in one call (Args empty, `;` between statements: lib/pq's simple query
//     protocol) run through exec and return no columns, no rows, Affected 0 (what Db.run does).
//   - The result, as JSON straight off PGlite's reply ({fields, rows, affected}, see
//     BackendResult's tags): every column with its name and type OID in select order; every row
//     as one value per column, each the value's Postgres text output (int8 "9007199254740993",
//     bool "t"/"f", timestamptz "2026-01-02 15:04:05.123+00", bytea "\x0102", numeric "12.50",
//     jsonb `{"a": 1}`, arrays `{1,2}` / `{"a b",NULL}` …) or null for NULL; Affected the rows
//     an INSERT/UPDATE/DELETE changed (result.affectedRows), -1 when unknown (the driver then
//     counts the rows returned).
//   - A statement the server rejects returns a *Error carrying the server's fields (pg-protocol's
//     DatabaseError → Error): code → Code (SQLSTATE), message → Message, detail, hint, position,
//     internalPosition, internalQuery, where, schema, table, column, dataType → DataTypeName,
//     constraint, severity, file, line, routine. Any other failure (no database in this
//     runtime) returns a plain error.
//
// Reset — Db.reset(schema): `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` + schema, run with
// exec, outside the lock and the logs (the harness calls it before a check that needs tables).
//
// The query log, the BEGIN/COMMIT/ROLLBACK events and the harness probes the Go harness reads are
// kept on the Go side (every statement of a Go check passes through here); the JavaScript Db keeps
// its own as usual.
type Backend interface {
	Hold(ctx context.Context) (release func(), err error)
	Run(ctx context.Context, st BackendStatement) (BackendResult, error)
	Reset(schema string) error
}

// BackendStatement is one statement for Backend.Run.
type BackendStatement struct {
	SQL     string
	Args    []any // nil | string (text format) | []byte (raw bytes)
	Held    bool  // the caller holds the connection (inside a transaction)
	Counted bool  // the learner's statement, not the harness's
}

// BackendResult is what a statement returned: PGlite's reply with rowMode 'array' and raw text.
type BackendResult struct {
	Columns  []BackendColumn `json:"fields"`
	Rows     [][]*string     `json:"rows"`     // text format; nil is NULL
	Affected int64           `json:"affected"` // -1: unknown
}

// BackendColumn is one result column.
type BackendColumn struct {
	Name string `json:"name"`
	OID  uint32 `json:"dataTypeID"`
}

var (
	backendMu sync.RWMutex
	backend   Backend
)

// SetBackend installs the database the driver talks to (nil: none).
func SetBackend(b Backend) {
	backendMu.Lock()
	defer backendMu.Unlock()
	backend = b
}

var errNoDatabase = errors.New("pq: the database is not available in this runtime")

func currentBackend() (Backend, error) {
	backendMu.RLock()
	defer backendMu.RUnlock()
	if backend == nil {
		return nil, errNoDatabase
	}
	return backend, nil
}

// LoggedQuery is one entry of the query log: the statement and its arguments as driver values
// (int64, float64, bool, string, []byte, time.Time, nil; arrays as their text form).
type LoggedQuery struct {
	SQL  string
	Args []driver.Value
}

type probe struct {
	pattern string
	fn      func()
	fired   bool
}

// world is what the harness sees of the statements: the query log, the transaction events, probes.
var world struct {
	sync.Mutex
	events  []string
	queries []LoggedQuery
	probes  []*probe
}

// run is the statement path every statement takes, learner's and harness's alike (Db.run): log
// it, run it, record BEGIN/COMMIT/ROLLBACK once it succeeded, then fire the probes it matches
// before the caller sees the outcome.
func run(ctx context.Context, sql string, args []driver.Value, held, counted bool) (BackendResult, error) {
	b, err := currentBackend()
	if err != nil {
		return BackendResult{}, err
	}
	encoded := make([]any, len(args))
	for i, a := range args {
		if encoded[i], err = encodeArg(a); err != nil {
			return BackendResult{}, err
		}
	}
	world.Lock()
	world.queries = append(world.queries, LoggedQuery{SQL: sql, Args: append([]driver.Value(nil), args...)})
	world.Unlock()
	res, err := b.Run(ctx, BackendStatement{SQL: sql, Args: encoded, Held: held, Counted: counted})
	if err == nil {
		if ev := eventOf(sql); ev != "" {
			world.Lock()
			world.events = append(world.events, ev)
			world.Unlock()
		}
	}
	fire(sql)
	return res, err
}

// eventOf classifies a statement the way pg.ts does.
func eventOf(sql string) string {
	upper := strings.ToUpper(strings.TrimSpace(sql))
	switch {
	case strings.HasPrefix(upper, "BEGIN"), strings.HasPrefix(upper, "START TRANSACTION"):
		return "BEGIN"
	case strings.HasPrefix(upper, "COMMIT"), strings.HasPrefix(upper, "END"):
		return "COMMIT"
	case strings.HasPrefix(upper, "ROLLBACK"), strings.HasPrefix(upper, "ABORT"):
		return "ROLLBACK"
	}
	return ""
}

// fire runs, once each, the probes whose pattern the statement contains (case-insensitive), on the
// statement's goroutine. A panicking probe does not reach the statement's caller.
func fire(sql string) {
	lower := strings.ToLower(sql)
	var due []*probe
	world.Lock()
	for _, p := range world.probes {
		if !p.fired && strings.Contains(lower, p.pattern) {
			p.fired = true
			due = append(due, p)
		}
	}
	world.Unlock()
	for _, p := range due {
		func() {
			defer func() { _ = recover() }()
			p.fn()
		}()
	}
}
