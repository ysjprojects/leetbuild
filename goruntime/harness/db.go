package harness

import (
	"context"
	"sync"

	"leetbuild/goruntime/models/pq"
)

// DB is ctx.DB, Postgres as the check sees it (the TS harness's ctx.db / ctx.dbAfter). The learner
// reaches the same database through database/sql and github.com/lib/pq; a transaction holds the
// single connection, so a harness statement issued meanwhile waits for its COMMIT/ROLLBACK. The
// harness's statements are logged and probed like the learner's but do not count in the metrics.
//
//	ctx.DB.Reset(schema)               drop every table and apply schema; clears events, queries, probes
//	ctx.DB.Query(sql, args...)         rows as []Row (column → value); fails the check on error
//	ctx.DB.Exec(sql, args...)          rows affected; fails the check on error
//	ctx.DB.Run(sql, args...)           rows, affected, err: a statement that may fail
//	ctx.DB.Events()                    "BEGIN" / "COMMIT" / "ROLLBACK" in order, as the database saw them
//	ctx.DB.Queries()                   every statement with its arguments, in order (learner's and harness's)
//	ctx.DB.After(pattern, fn)          run fn right after the first statement containing pattern
//
// Arguments are Go values: ints, floats, bool, string, []byte, time.Time, nil, pointers to them,
// and slices, which go as Postgres arrays (`= ANY($1)`). Row values: integers int64, floats float64,
// bool, text/varchar/uuid string, numeric string, bytea []byte, date/timestamp/timestamptz
// time.Time, json/jsonb decoded by encoding/json (map[string]any, float64 …), arrays []any, NULL nil.
type DB struct{ ctx *Ctx }

// newDB starts the check's database log afresh: no events, no queries, no probes.
func newDB(c *Ctx) *DB {
	pq.HarnessClear()
	return &DB{ctx: c}
}

// Row is one result row: column name → value.
type Row map[string]any

// DBQuery is one statement of the query log, with the arguments as the driver passed them
// (int64, float64, bool, string, []byte, time.Time, nil; a pq.Array as its text form "{a,b}").
type DBQuery struct {
	SQL  string
	Args []any
}

// Reset drops every table, applies schema (DDL) and clears the events, the query log and the probes.
func (v *DB) Reset(schema string) {
	if err := pq.HarnessReset(schema); err != nil {
		v.ctx.Fatalf("ctx.DB.Reset: %v", err)
	}
}

// Run runs one statement (autocommit) and returns its rows, the rows it affected (the rows it
// returned, for a SELECT) and the error, without failing the check.
func (v *DB) Run(sql string, args ...any) ([]Row, int64, error) {
	rows, affected, err := pq.HarnessRun(context.Background(), sql, args...)
	if err != nil {
		return nil, 0, err
	}
	out := make([]Row, len(rows))
	for i, r := range rows {
		out[i] = Row(r)
	}
	return out, affected, nil
}

// Query runs one statement and returns its rows; an error fails the check.
func (v *DB) Query(sql string, args ...any) []Row {
	rows, _, err := v.Run(sql, args...)
	if err != nil {
		v.ctx.Fatalf("ctx.DB.Query(%q): %v", sql, err)
	}
	return rows
}

// Exec runs one statement and returns the rows it affected; an error fails the check.
func (v *DB) Exec(sql string, args ...any) int64 {
	_, affected, err := v.Run(sql, args...)
	if err != nil {
		v.ctx.Fatalf("ctx.DB.Exec(%q): %v", sql, err)
	}
	return affected
}

// Events returns BEGIN / COMMIT / ROLLBACK, in order, for every such statement that succeeded since
// the check began (or since Reset).
func (v *DB) Events() []string {
	events, _ := pq.HarnessLog()
	return events
}

// Queries returns every statement run since the check began (or since Reset), learner's and
// harness's, in order, failed ones included.
func (v *DB) Queries() []DBQuery {
	_, queries := pq.HarnessLog()
	out := make([]DBQuery, len(queries))
	for i, q := range queries {
		args := make([]any, len(q.Args))
		for j, a := range q.Args {
			args[j] = a
		}
		out[i] = DBQuery{SQL: q.SQL, Args: args}
	}
	return out
}

// DBProbe is a probe set with After.
type DBProbe struct {
	mu        sync.Mutex
	fired     bool
	recovered any
}

// Fired reports whether the probe ran.
func (p *DBProbe) Fired() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.fired
}

// Recovered returns what fn panicked with (a failed assertion inside it, for one), nil if it
// returned normally. A probe's panic does not fail the check by itself, nor reach the learner.
func (p *DBProbe) Recovered() any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.recovered
}

// After runs fn once, right after the first statement whose text contains pattern
// (case-insensitive) has run on the server, succeeded or failed, before its caller sees the
// outcome: a slow write (advance the clock while the transaction is open), a snapshot of the world
// mid-transaction. fn runs on the learner's goroutine; when that statement is inside a transaction
// the connection is still held, so a ctx.DB statement in fn would wait for the transaction — start
// it in a goroutine (`go ctx.DB.Exec(...)`) to have it run right after the transaction ends.
func (v *DB) After(pattern string, fn func()) *DBProbe {
	p := &DBProbe{}
	pq.HarnessAfter(pattern, func() {
		defer func() {
			r := recover()
			p.mu.Lock()
			p.fired, p.recovered = true, r
			p.mu.Unlock()
		}()
		fn()
	})
	return p
}
