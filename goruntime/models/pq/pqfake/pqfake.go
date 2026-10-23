// Package pqfake is a scripted pq.Backend for native tests of code on the pq model and the harness
// DB view: it keeps the single-connection discipline of the real backend (a statement either holds
// the connection itself or arrives inside a Hold) and answers each statement through a handler the
// test writes. It does not interpret SQL.
package pqfake

import (
	"context"
	"fmt"
	"sync"

	"leetbuild/goruntime/models/pq"
)

// Type OIDs for building results.
const (
	Bool        uint32 = 16
	Bytea       uint32 = 17
	Int8        uint32 = 20
	Int2        uint32 = 21
	Int4        uint32 = 23
	Text        uint32 = 25
	JSON        uint32 = 114
	Float4      uint32 = 700
	Float8      uint32 = 701
	Varchar     uint32 = 1043
	Date        uint32 = 1082
	Timestamp   uint32 = 1114
	Timestamptz uint32 = 1184
	Numeric     uint32 = 1700
	UUID        uint32 = 2950
	JSONB       uint32 = 3802
	TextArray   uint32 = 1009
	Int8Array   uint32 = 1016
)

// Handler answers one statement.
type Handler func(st pq.BackendStatement) (pq.BackendResult, error)

// Backend is the fake database.
type Backend struct {
	handle Handler
	lock   chan struct{}

	mu         sync.Mutex
	held       bool
	holds      int
	statements []pq.BackendStatement
	violations []string
	schemas    []string
}

// New returns a backend answering with handle (nil: every statement returns nothing).
func New(handle Handler) *Backend {
	return &Backend{handle: handle, lock: make(chan struct{}, 1)}
}

// Hold takes the single connection, waiting for the holder to release it.
func (b *Backend) Hold(ctx context.Context) (func(), error) {
	select {
	case b.lock <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	b.mu.Lock()
	b.held = true
	b.holds++
	b.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			b.held = false
			b.mu.Unlock()
			<-b.lock
		})
	}, nil
}

// Run records the statement and answers it; without Held it takes the connection for itself.
func (b *Backend) Run(ctx context.Context, st pq.BackendStatement) (pq.BackendResult, error) {
	if !st.Held {
		b.lock <- struct{}{}
		defer func() { <-b.lock }()
	}
	b.mu.Lock()
	if st.Held && !b.held {
		b.violations = append(b.violations, fmt.Sprintf("%q arrived as held while nobody holds the connection", st.SQL))
	}
	b.statements = append(b.statements, st)
	b.mu.Unlock()
	if b.handle == nil {
		return pq.BackendResult{Affected: -1}, nil
	}
	return b.handle(st)
}

// Reset records the schema.
func (b *Backend) Reset(schema string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.schemas = append(b.schemas, schema)
	return nil
}

// Statements returns what was run so far, in order.
func (b *Backend) Statements() []pq.BackendStatement {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]pq.BackendStatement(nil), b.statements...)
}

// Violations returns the contract breaches seen (held statements outside a Hold).
func (b *Backend) Violations() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.violations...)
}

// Held reports whether a Hold is in force.
func (b *Backend) Held() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.held
}

// Holds counts the Holds taken so far.
func (b *Backend) Holds() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.holds
}

// Schemas returns the schemas Reset applied, in order.
func (b *Backend) Schemas() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.schemas...)
}

// Col is a result column.
func Col(name string, oid uint32) pq.BackendColumn { return pq.BackendColumn{Name: name, OID: oid} }

// Rows builds a SELECT result; each value is nil (NULL) or the value's text format.
func Rows(cols []pq.BackendColumn, rows ...[]any) pq.BackendResult {
	out := pq.BackendResult{Columns: cols, Rows: make([][]*string, len(rows)), Affected: -1}
	for i, row := range rows {
		out.Rows[i] = make([]*string, len(row))
		for j, v := range row {
			switch x := v.(type) {
			case nil:
			case string:
				out.Rows[i][j] = &x
			default:
				s := fmt.Sprint(x)
				out.Rows[i][j] = &s
			}
		}
	}
	return out
}

// Affected is the result of a write that changed n rows.
func Affected(n int64) pq.BackendResult { return pq.BackendResult{Affected: n} }
