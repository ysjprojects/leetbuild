package pq_test

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"leetbuild/goruntime/models/pq"
	"leetbuild/goruntime/models/pq/pqfake"
)

func open(t *testing.T, handle pqfake.Handler) (*sql.DB, *pqfake.Backend) {
	t.Helper()
	fake := pqfake.New(handle)
	pq.SetBackend(fake)
	pq.HarnessClear()
	t.Cleanup(func() {
		if v := fake.Violations(); len(v) > 0 {
			t.Errorf("backend contract violated: %v", v)
		}
		pq.SetBackend(nil)
	})
	db, err := sql.Open("postgres", "postgres://app:secret@db:5432/app?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, fake
}

func TestDecodesColumnsByType(t *testing.T) {
	db, _ := open(t, func(st pq.BackendStatement) (pq.BackendResult, error) {
		return pqfake.Rows([]pq.BackendColumn{
			pqfake.Col("i8", pqfake.Int8), pqfake.Col("i4", pqfake.Int4), pqfake.Col("i2", pqfake.Int2),
			pqfake.Col("f8", pqfake.Float8), pqfake.Col("f4", pqfake.Float4), pqfake.Col("num", pqfake.Numeric),
			pqfake.Col("b", pqfake.Bool), pqfake.Col("t", pqfake.Text), pqfake.Col("v", pqfake.Varchar),
			pqfake.Col("bin", pqfake.Bytea), pqfake.Col("ts", pqfake.Timestamp), pqfake.Col("tz", pqfake.Timestamptz),
			pqfake.Col("d", pqfake.Date), pqfake.Col("j", pqfake.JSONB), pqfake.Col("u", pqfake.UUID),
			pqfake.Col("arr", pqfake.TextArray), pqfake.Col("null", pqfake.Text),
		}, []any{"9007199254740993", "-7", "3", "2.5", "0.1", "12.50", "t", "hello", "v", `\x00ff41`,
			"2026-01-02 15:04:05.123456", "2026-01-02 15:04:05.5+00", "2026-01-02", `{"a": 1}`,
			"0b9c8f2e-1d3a-4c5b-9e7f-1a2b3c4d5e6f", `{a,"b c",NULL}`, nil}), nil
	})
	var (
		i8, i4, i2 int64
		f8, f4     float64
		num        float64
		b          bool
		text, v    string
		bin        []byte
		ts, tz, d  time.Time
		j          []byte
		u          string
		arr        []sql.NullString
		null       sql.NullString
	)
	row := db.QueryRow("SELECT * FROM t WHERE id = $1", 1)
	if err := row.Scan(&i8, &i4, &i2, &f8, &f4, &num, &b, &text, &v, &bin, &ts, &tz, &d, &j, &u, pq.Array(&arr), &null); err != nil {
		t.Fatal(err)
	}
	if i8 != 9007199254740993 || i4 != -7 || i2 != 3 || f8 != 2.5 || f4 != 0.1 || num != 12.5 || !b || text != "hello" || v != "v" {
		t.Fatalf("scalars: %v %v %v %v %v %v %v %q %q", i8, i4, i2, f8, f4, num, b, text, v)
	}
	if !reflect.DeepEqual(bin, []byte{0, 0xff, 'A'}) {
		t.Fatalf("bytea: %v", bin)
	}
	if want := time.Date(2026, 1, 2, 15, 4, 5, 123456000, time.UTC); !ts.Equal(want) {
		t.Fatalf("timestamp: %v", ts)
	}
	if tz.Location() != time.UTC || !tz.Equal(time.Date(2026, 1, 2, 15, 4, 5, 5e8, time.UTC)) {
		t.Fatalf("timestamptz: %v (%v)", tz, tz.Location())
	}
	if d.Year() != 2026 || d.Month() != 1 || d.Day() != 2 {
		t.Fatalf("date: %v", d)
	}
	if string(j) != `{"a": 1}` || u != "0b9c8f2e-1d3a-4c5b-9e7f-1a2b3c4d5e6f" {
		t.Fatalf("json/uuid: %s %s", j, u)
	}
	if len(arr) != 3 || arr[0].String != "a" || arr[1].String != "b c" || arr[2].Valid || null.Valid {
		t.Fatalf("array/null: %v %v", arr, null)
	}
	// What a scan into any gets: lib/pq's driver values.
	rows, err := db.Query("SELECT 1")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	rows.Next()
	cols, _ := rows.ColumnTypes()
	if cols[0].DatabaseTypeName() != "INT8" || cols[15].DatabaseTypeName() != "_TEXT" {
		t.Fatalf("type names: %s %s", cols[0].DatabaseTypeName(), cols[15].DatabaseTypeName())
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		t.Fatal(err)
	}
	if _, ok := vals[0].(int64); !ok {
		t.Fatalf("int8 → %T", vals[0])
	}
	if _, ok := vals[3].(float64); !ok {
		t.Fatalf("float8 → %T", vals[3])
	}
	if s, ok := vals[5].([]byte); !ok || string(s) != "12.50" {
		t.Fatalf("numeric → %T %v", vals[5], vals[5])
	}
	if _, ok := vals[10].(time.Time); !ok {
		t.Fatalf("timestamp → %T", vals[10])
	}
	if _, ok := vals[13].([]byte); !ok {
		t.Fatalf("jsonb → %T", vals[13])
	}
	if vals[16] != nil {
		t.Fatalf("NULL → %v", vals[16])
	}
}

func TestEncodesArguments(t *testing.T) {
	db, fake := open(t, func(st pq.BackendStatement) (pq.BackendResult, error) { return pqfake.Affected(1), nil })
	var none *string
	some := "evt-1"
	when := time.Date(2026, 3, 4, 5, 6, 7, 8000, time.UTC)
	res, err := db.Exec("INSERT INTO t VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
		42, int32(-3), 1.5, true, "text", []byte(`{"json":true}`), when, nil, none, &some,
		pq.Array([]string{"e1", `quo"te`}), pq.Array([]int64{1, 2}))
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		t.Fatalf("RowsAffected %d", n)
	}
	got := fake.Statements()[0].Args
	want := []any{"42", "-3", "1.5", "true", "text", []byte(`{"json":true}`), "2026-03-04 05:06:07.000008Z", nil, nil, "evt-1",
		`{"e1","quo\"te"}`, "{1,2}"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args\n got %#v\nwant %#v", got, want)
	}
	if st := fake.Statements()[0]; st.Held || !st.Counted || !strings.HasPrefix(st.SQL, "INSERT INTO t VALUES ($1,") {
		t.Fatalf("statement %+v", st)
	}
	_, queries := pq.HarnessLog()
	if len(queries) != 1 || queries[0].Args[0] != int64(42) || queries[0].Args[9] != "evt-1" {
		t.Fatalf("log %+v", queries)
	}
}

func TestTransactionHoldsTheConnection(t *testing.T) {
	db, fake := open(t, func(st pq.BackendStatement) (pq.BackendResult, error) { return pqfake.Affected(1), nil })
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !fake.Held() {
		t.Fatal("BeginTx must hold the connection")
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO a VALUES ($1)", 1); err != nil {
		t.Fatal(err)
	}
	outside := make(chan error, 1)
	go func() {
		_, err := db.ExecContext(ctx, "INSERT INTO b VALUES (1)")
		outside <- err
	}()
	select {
	case <-outside:
		t.Fatal("a statement outside the transaction ran while it held the connection")
	case <-time.After(50 * time.Millisecond):
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-outside; err != nil {
		t.Fatal(err)
	}
	if fake.Held() {
		t.Fatal("Commit must release the connection")
	}
	var sqls []string
	var held []bool
	for _, st := range fake.Statements() {
		sqls = append(sqls, st.SQL)
		held = append(held, st.Held)
	}
	if !reflect.DeepEqual(sqls, []string{"BEGIN READ WRITE", "INSERT INTO a VALUES ($1)", "COMMIT", "INSERT INTO b VALUES (1)"}) ||
		!reflect.DeepEqual(held, []bool{true, true, true, false}) {
		t.Fatalf("statements %q held %v", sqls, held)
	}
	tx, err = db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if fake.Held() {
		t.Fatal("Rollback must release the connection")
	}
	all := fake.Statements()
	if all[4].SQL != "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY" || all[5].SQL != "ROLLBACK" {
		t.Fatalf("got %q, %q", all[4].SQL, all[5].SQL)
	}
	events, _ := pq.HarnessLog()
	if !reflect.DeepEqual(events, []string{"BEGIN", "COMMIT", "BEGIN", "ROLLBACK"}) {
		t.Fatalf("events %v", events)
	}
}

func TestFailedTransactionCommitReportsIt(t *testing.T) {
	db, fake := open(t, func(st pq.BackendStatement) (pq.BackendResult, error) {
		if strings.Contains(st.SQL, "bad") {
			return pq.BackendResult{}, &pq.Error{Code: "23514", Message: `new row for relation "t" violates check constraint "t_check"`, Constraint: "t_check", Table: "t"}
		}
		return pqfake.Affected(1), nil
	})
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO t VALUES ('bad')"); err == nil {
		t.Fatal("expected the constraint error")
	}
	if err := tx.Commit(); !errors.Is(err, pq.ErrInFailedTransaction) {
		t.Fatalf("Commit after a failed statement: %v", err)
	}
	if fake.Held() {
		t.Fatal("the connection must be released")
	}
}

func TestErrorsArePqErrors(t *testing.T) {
	db, _ := open(t, func(st pq.BackendStatement) (pq.BackendResult, error) {
		return pq.BackendResult{}, &pq.Error{Severity: "ERROR", Code: "23505", Message: `duplicate key value violates unique constraint "orders_pkey"`,
			Detail: "Key (id)=(o-1) already exists.", Constraint: "orders_pkey", Table: "orders", Schema: "public"}
	})
	_, err := db.Exec("INSERT INTO orders (id) VALUES ($1)", "o-1")
	var pqErr *pq.Error
	if !errors.As(err, &pqErr) {
		t.Fatalf("not a *pq.Error: %T %v", err, err)
	}
	if pqErr.Code != "23505" || pqErr.Code.Name() != "unique_violation" || pqErr.Code.Class() != "23" ||
		pqErr.Code.Class().Name() != "integrity_constraint_violation" || pqErr.Constraint != "orders_pkey" ||
		pqErr.Detail != "Key (id)=(o-1) already exists." || pqErr.SQLState() != "23505" || pqErr.Get('n') != "orders_pkey" {
		t.Fatalf("error fields: %+v", pqErr)
	}
	if err.Error() != `pq: duplicate key value violates unique constraint "orders_pkey"` {
		t.Fatalf("message %q", err.Error())
	}
}

func TestNoBackend(t *testing.T) {
	pq.SetBackend(nil)
	db, err := sql.Open("postgres", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("SELECT 1"); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("got %v", err)
	}
}

func TestArrayRoundTrip(t *testing.T) {
	strs := []string{"plain", "with space", `quo"te`, `back\slash`, "", "NULL"}
	v, err := pq.Array(strs).Value()
	if err != nil {
		t.Fatal(err)
	}
	var back []string
	if err := pq.Array(&back).Scan([]byte(v.(string))); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, strs) {
		t.Fatalf("strings: %q → %v → %q", strs, v, back)
	}
	for _, tc := range []struct {
		in, out any
	}{
		{[]int64{1, -2, 3}, &[]int64{}},
		{[]float64{1.5, -2}, &[]float64{}},
		{[]bool{true, false}, &[]bool{}},
		{[][]byte{{0, 1}, []byte("x")}, &[][]byte{}},
		{[]int32{7}, &[]int32{}},
	} {
		v, err := pq.Array(tc.in).Value()
		if err != nil {
			t.Fatal(err)
		}
		var src any = v
		if s, ok := v.(string); ok {
			src = []byte(s)
		}
		if err := pq.Array(tc.out).Scan(src); err != nil {
			t.Fatalf("%T: %v", tc.in, err)
		}
		if got := reflect.ValueOf(tc.out).Elem().Interface(); !reflect.DeepEqual(got, tc.in) {
			t.Fatalf("%T: %v → %v → %v", tc.in, tc.in, v, got)
		}
	}
	// A generic slice encodes through GenericArray; nil is NULL; empty is {}.
	if v, _ := pq.Array([]int{1, 2}).Value(); v != "{1,2}" {
		t.Fatalf("[]int → %v", v)
	}
	if v, _ := pq.Array([]string(nil)).Value(); v != nil {
		t.Fatalf("nil → %v", v)
	}
	if v, _ := pq.Array([]string{}).Value(); v != "{}" {
		t.Fatalf("empty → %v", v)
	}
	// Through the driver: an array column scans with pq.Array.
	db, _ := open(t, func(st pq.BackendStatement) (pq.BackendResult, error) {
		return pqfake.Rows([]pq.BackendColumn{pqfake.Col("ids", pqfake.Int8Array)}, []any{"{3,1,2}"}), nil
	})
	var ids []int64
	if err := db.QueryRow("SELECT ids FROM t").Scan(pq.Array(&ids)); err != nil || !reflect.DeepEqual(ids, []int64{3, 1, 2}) {
		t.Fatalf("scan: %v %v", ids, err)
	}
}

func TestProbesFireBeforeTheCallerSeesTheOutcome(t *testing.T) {
	var order []string
	db, _ := open(t, func(st pq.BackendStatement) (pq.BackendResult, error) {
		order = append(order, "server: "+st.SQL)
		if strings.Contains(st.SQL, "fail") {
			return pq.BackendResult{}, &pq.Error{Code: "42P01", Message: "relation does not exist"}
		}
		return pqfake.Affected(1), nil
	})
	fired := 0
	pq.HarnessAfter("insert into TRANSACTIONS", func() {
		fired++
		order = append(order, "probe")
		panic("a probe's panic stays in the probe")
	})
	pq.HarnessAfter("fail", func() { order = append(order, "probe on failure") })
	if _, err := db.Exec("INSERT INTO transactions VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	order = append(order, "caller")
	if _, err := db.Exec("INSERT INTO transactions VALUES (2)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("SELECT fail"); err == nil {
		t.Fatal("expected an error")
	}
	want := []string{"server: INSERT INTO transactions VALUES (1)", "probe", "caller", "server: INSERT INTO transactions VALUES (2)",
		"server: SELECT fail", "probe on failure"}
	if fired != 1 || !reflect.DeepEqual(order, want) {
		t.Fatalf("fired %d order %q", fired, order)
	}
	_, queries := pq.HarnessLog()
	if len(queries) != 3 {
		t.Fatalf("failed statements are logged too: %d", len(queries))
	}
}

func TestHarnessRunDecodesAndDoesNotCount(t *testing.T) {
	_, fake := open(t, func(st pq.BackendStatement) (pq.BackendResult, error) {
		return pqfake.Rows([]pq.BackendColumn{pqfake.Col("id", pqfake.Text), pqfake.Col("n", pqfake.Numeric),
			pqfake.Col("j", pqfake.JSON), pqfake.Col("a", pqfake.Int8Array), pqfake.Col("sent_at", pqfake.Timestamptz)},
			[]any{"e1", "1.50", `{"k":[1,"x"]}`, "{{1,2},{3,NULL}}", nil}), nil
	})
	rows, n, err := pq.HarnessRun(context.Background(), "SELECT * FROM t WHERE id = ANY($1)", []string{"e1", "e2"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"id": "e1", "n": "1.50", "j": map[string]any{"k": []any{1.0, "x"}},
		"a": []any{[]any{int64(1), int64(2)}, []any{int64(3), nil}}, "sent_at": nil}
	if n != 1 || !reflect.DeepEqual(rows, []map[string]any{want}) {
		t.Fatalf("rows %#v n %d", rows, n)
	}
	st := fake.Statements()[0]
	if st.Counted || st.Held || !reflect.DeepEqual(st.Args, []any{`{"e1","e2"}`}) {
		t.Fatalf("statement %+v", st)
	}
}
