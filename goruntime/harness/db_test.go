package harness

import (
	"database/sql"
	"reflect"
	"strings"
	"testing"
	"time"

	"leetbuild/goruntime/models/pq"
	"leetbuild/goruntime/models/pq/pqfake"
)

type dbHost struct{}

func (dbHost) Settle()                      {}
func (dbHost) Interrupted() <-chan struct{} { return nil }

// failure runs fn and returns the message of the check failure it raised ("" if none).
func failure(fn func()) (msg string) {
	defer func() {
		if r := recover(); r != nil {
			msg = r.(Failure).Message
		}
	}()
	fn()
	return ""
}

func TestDBView(t *testing.T) {
	fake := pqfake.New(func(st pq.BackendStatement) (pq.BackendResult, error) {
		switch {
		case strings.HasPrefix(st.SQL, "SELECT"):
			return pqfake.Rows([]pq.BackendColumn{pqfake.Col("id", pqfake.Text), pqfake.Col("amount", pqfake.Int8),
				pqfake.Col("payload", pqfake.JSONB), pqfake.Col("sent_at", pqfake.Timestamptz)},
				[]any{"e1", "4999", `{"type":"payment.captured"}`, "2026-01-02 03:04:05+00"},
				[]any{"e2", "-1", `{}`, nil}), nil
		case strings.Contains(st.SQL, "broken"):
			return pq.BackendResult{}, &pq.Error{Code: "23514", Message: "violates check constraint"}
		}
		return pqfake.Affected(2), nil
	})
	pq.SetBackend(fake)
	defer pq.SetBackend(nil)
	pq.HarnessAfter("stale probe from an earlier check", func() { t.Error("newDB must drop earlier probes") })

	ctx := New(dbHost{})
	ctx.DB.Reset("CREATE TABLE outbox (id text);")
	if got := fake.Schemas(); !reflect.DeepEqual(got, []string{"CREATE TABLE outbox (id text);"}) {
		t.Fatalf("schemas %q", got)
	}

	if n := ctx.DB.Exec("UPDATE outbox SET sent_at = now() WHERE id = ANY($1)", []string{"e1", "e2"}); n != 2 {
		t.Fatalf("Exec affected %d", n)
	}
	rows := ctx.DB.Query("SELECT id, amount, payload, sent_at FROM outbox ORDER BY id")
	want := []Row{
		{"id": "e1", "amount": int64(4999), "payload": map[string]any{"type": "payment.captured"},
			"sent_at": time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)},
		{"id": "e2", "amount": int64(-1), "payload": map[string]any{}, "sent_at": nil},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows %#v", rows)
	}
	ctx.Equal(rows[0]["amount"], 4999, "amount compares across integer types")

	msg := failure(func() { ctx.DB.Exec("INSERT INTO outbox VALUES ('broken')") })
	if !strings.Contains(msg, "violates check constraint") || !strings.Contains(msg, "ctx.DB.Exec") {
		t.Fatalf("Exec failure message %q", msg)
	}
	if _, _, err := ctx.DB.Run("INSERT INTO outbox VALUES ('broken')"); err == nil {
		t.Fatal("Run must return the error")
	}

	// The learner's transaction, through database/sql.
	db, err := sql.Open("postgres", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	probe := ctx.DB.After("INSERT INTO ORDERS", func() {
		if !fake.Held() {
			t.Error("the probe runs while the transaction still holds the connection")
		}
		ctx.Fatalf("recorded, not raised")
	})
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO orders VALUES ($1, $2)", "o-1", 4999); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if !probe.Fired() || probe.Recovered().(Failure).Message != "recorded, not raised" {
		t.Fatalf("probe fired %v recovered %v", probe.Fired(), probe.Recovered())
	}
	if got := ctx.DB.Events(); !reflect.DeepEqual(got, []string{"BEGIN", "COMMIT"}) {
		t.Fatalf("events %q", got)
	}
	queries := ctx.DB.Queries()
	if len(queries) != 7 {
		t.Fatalf("queries %+v", queries)
	}
	if q := queries[5]; q.SQL != "INSERT INTO orders VALUES ($1, $2)" || !reflect.DeepEqual(q.Args, []any{"o-1", int64(4999)}) {
		t.Fatalf("logged %+v", q)
	}
	if q := queries[0]; !reflect.DeepEqual(q.Args, []any{`{"e1","e2"}`}) {
		t.Fatalf("logged array %+v", q)
	}
	var counted int
	for _, st := range fake.Statements() {
		if st.Counted {
			counted++
		}
	}
	if counted != 3 {
		t.Fatalf("learner statements %d, want 3 (BEGIN, INSERT, COMMIT)", counted)
	}

	ctx.DB.Reset("")
	if len(ctx.DB.Events()) != 0 || len(ctx.DB.Queries()) != 0 {
		t.Fatal("Reset clears the logs")
	}
}

func TestDBViewWithoutDatabase(t *testing.T) {
	pq.SetBackend(nil)
	ctx := New(dbHost{})
	if msg := failure(func() { ctx.DB.Query("SELECT 1") }); !strings.Contains(msg, "not available") {
		t.Fatalf("got %q", msg)
	}
}
