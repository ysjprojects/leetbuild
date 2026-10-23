package pq_test

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"leetbuild/goruntime/harness"
	"leetbuild/goruntime/models/pq"
	"leetbuild/goruntime/models/pq/pqfake"
	"leetbuild/goruntime/symbols"
	"leetbuild/goruntime/yaegitest"
)

// The real course Go solutions of the harnessed SQL steps, compiled and run in the interpreter on
// this model, with the course helper packages (`payments/db`, `discord/db`, `ledger/db`) written
// the way their comments describe them and stubs for the models other agents build.

const problems = "../../../src/data/problems"

// solution returns code.go.solution of a step file: the template literal, cooked.
func solution(t *testing.T, step string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(problems, step))
	if err != nil {
		t.Fatal(err)
	}
	src := string(data)
	at := strings.Index(src, "\n    go: {\n")
	if at < 0 {
		t.Fatalf("%s: no go code", step)
	}
	key := "solution: `"
	at = strings.Index(src[at:], key) + at + len(key)
	var out strings.Builder
	for i := at; i < len(src); i++ {
		switch c := src[i]; c {
		case '`':
			return out.String()
		case '\\':
			i++
			switch e := src[i]; e {
			case 'n':
				out.WriteByte('\n')
			case 't':
				out.WriteByte('\t')
			case 'r':
				out.WriteByte('\r')
			default:
				out.WriteByte(e)
			}
		default:
			out.WriteByte(c)
		}
	}
	t.Fatalf("%s: unterminated solution", step)
	return ""
}

// Course helpers, as the solutions' import comments describe them. (`var pool, _ = sql.Open(…)` at
// package level trips yaegi: pool gets the wrong type and every method call on it panics with
// "reflect: Method index out of range". Hence open().)
const (
	transactionHelper = `
// Transaction begins, runs fn, commits (rolls back on error).
func Transaction(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := pool.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}
`
	helperHead = `package db

import (
	"context"
	"database/sql"

	_ "github.com/lib/pq"
)

var pool = open()

func open() *sql.DB {
	db, err := sql.Open("postgres", "postgres://app@db:5432/app?sslmode=disable")
	if err != nil {
		panic(err)
	}
	return db
}
`
	paymentsDB = helperHead + transactionHelper
	ledgerDB   = helperHead + transactionHelper + `
func QueryRow(ctx context.Context, query string, args ...any) *sql.Row {
	return pool.QueryRowContext(ctx, query, args...)
}
`
	discordDB = helperHead + `
func Exec(ctx context.Context, query string, args ...any) error {
	_, err := pool.ExecContext(ctx, query, args...)
	return err
}

func Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return pool.QueryContext(ctx, query, args...)
}
`
)

// Stand-ins for models that are not in the symbol tables yet (a binary package wins over these).
var stubs = map[string]string{
	"src/github.com/segmentio/kafka-go/kafka.go": `package kafka

import (
	"context"
	"net"
)

type Message struct {
	Topic      string
	Key, Value []byte
}

type Balancer interface{}
type Hash struct{}
type RequiredAcks int

const RequireAll RequiredAcks = -1

func TCP(address ...string) net.Addr { return nil }

// WriteErrors is here for the solution to compile. A partial failure cannot be returned: an
// interpreted WriteErrors is not an error to the native errors.As (yaegi), so the real kafka-go
// model must define it natively.
type WriteErrors []error

func (e WriteErrors) Error() string { return "kafka write errors" }

// Written is what writers produced.
var Written []Message

type Writer struct {
	Addr         net.Addr
	Balancer     Balancer
	RequiredAcks RequiredAcks
}

func (w *Writer) WriteMessages(ctx context.Context, msgs ...Message) error {
	Written = append(Written, msgs...)
	return nil
}
`,
	"src/google.golang.org/grpc/grpc.go": `package grpc

import "net"

type Server struct{}

func NewServer(opts ...any) *Server { return &Server{} }

func (s *Server) Serve(lis net.Listener) error { return nil }
`,
	"src/google.golang.org/grpc/codes/codes.go": `package codes

type Code uint32

const (
	InvalidArgument Code = 3
	NotFound        Code = 5
	Unavailable     Code = 14
)
`,
	"src/google.golang.org/grpc/status/status.go": `package status

import (
	"fmt"

	"google.golang.org/grpc/codes"
)

func Error(c codes.Code, msg string) error { return fmt.Errorf("rpc error: code = %d desc = %s", c, msg) }

func Errorf(c codes.Code, format string, a ...any) error { return Error(c, fmt.Sprintf(format, a...)) }
`,
	"src/ledger/gen/ledger/ledger.pb.go": `package ledger

import "context"

type BalanceRequest struct {
	Account, Currency string
	AsOf              int64
}

func (r *BalanceRequest) GetAccount() string  { return r.Account }
func (r *BalanceRequest) GetCurrency() string { return r.Currency }
func (r *BalanceRequest) GetAsOf() int64      { return r.AsOf }

type Balance struct {
	Account, Currency string
	Amount, AsOf      int64
}

type UnimplementedLedgerServiceServer struct{}

func (UnimplementedLedgerServiceServer) GetBalance(context.Context, *BalanceRequest) (*Balance, error) {
	return nil, nil
}

func RegisterLedgerServiceServer(s any, srv any) {}
`,
}

type checkHost struct{}

func (checkHost) Settle()                      {}
func (checkHost) Interrupted() <-chan struct{} { return nil }

// runChecks compiles the step's solution with its helper and the given Go harness, then runs each
// check against a fake backend answering with handle.
func runChecks(t *testing.T, step, helperPath, helper, checks string, handle pqfake.Handler, names ...string) *pqfake.Backend {
	t.Helper()
	files := map[string]string{
		"src/main/solution.go":     solution(t, step),
		"src/main/harness_test.go": checks,
		helperPath:                 helper,
	}
	for path, src := range stubs {
		files[path] = src
	}
	i, err := yaegitest.Compile(files)
	if err != nil {
		t.Fatalf("%s does not compile: %v", step, err)
	}
	fake := pqfake.New(handle)
	pq.SetBackend(fake)
	t.Cleanup(func() { pq.SetBackend(nil) })
	for _, name := range names {
		check, err := i.Func(name)
		if err != nil {
			t.Fatal(err)
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("%s %s failed: %v", step, name, r)
				}
			}()
			check.Call([]reflect.Value{reflect.ValueOf(harness.New(checkHost{}))})
		}()
	}
	if len(i.Panics) > 0 {
		t.Errorf("goroutine panics: %v", i.Panics)
	}
	if v := fake.Violations(); len(v) > 0 {
		t.Errorf("backend contract violated: %v", v)
	}
	return fake
}

func failOn(st pq.BackendStatement, sqlPart string, arg any, code pq.ErrorCode) error {
	if !strings.Contains(st.SQL, sqlPart) {
		return nil
	}
	for _, a := range st.Args {
		if reflect.DeepEqual(a, arg) {
			return &pq.Error{Code: code, Message: "rejected by the fake: " + code.Name(), Constraint: "check"}
		}
	}
	return nil
}

func TestCourseOutboxWrite(t *testing.T) {
	runChecks(t, "02-merchant-payments/steps/3-outbox-write.ts", "src/payments/db/db.go", paymentsDB, `package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/lib/pq"

	"leetbuild/harness"
)

func CheckAtomic(ctx *harness.Ctx) {
	ctx.DB.Reset("CREATE TABLE orders (id text); CREATE TABLE outbox (id text);")
	id, err := recordCapture(context.Background(), Order{ID: "o-1", MerchantID: "m-42"}, Capture{AmountCents: 4999, Currency: "EUR"})
	ctx.NoError(err, "recordCapture")
	ctx.Equal(ctx.DB.Events(), []string{"BEGIN", "COMMIT"}, "both rows in one transaction")
	qs := ctx.DB.Queries()
	ctx.Equal(len(qs), 4, "BEGIN, two inserts, COMMIT")
	ctx.Equal(qs[1].Args, []any{"o-1", "m-42", int64(4999), "EUR"}, "orders insert args")
	ctx.Equal(qs[2].Args[0], id, "the outbox row id is the returned event id")
	var event map[string]any
	ctx.NoError(json.Unmarshal(qs[2].Args[3].([]byte), &event), "payload is JSON")
	ctx.Equal(event["event_id"], id, "payload.event_id")
	ctx.Equal(event["amount_cents"], 4999, "payload.amount_cents")

	_, err = recordCapture(context.Background(), Order{ID: "o-2", MerchantID: "m-broken"}, Capture{AmountCents: 1, Currency: "EUR"})
	var pqErr *pq.Error
	ctx.Assert(errors.As(err, &pqErr), "the outbox failure propagates as *pq.Error, got %v", err)
	ctx.Equal(string(pqErr.Code), "23514", "code")
	events := ctx.DB.Events()
	ctx.Equal(events[len(events)-1], "ROLLBACK", "the failed transaction rolls back")
}
`, func(st pq.BackendStatement) (pq.BackendResult, error) {
		if err := failOn(st, "INSERT INTO outbox", "m-broken", "23514"); err != nil {
			return pq.BackendResult{}, err
		}
		return pqfake.Affected(1), nil
	}, "CheckAtomic")
}

func TestCourseOutboxRelay(t *testing.T) {
	_, kafkaModel := symbols.Symbols["github.com/segmentio/kafka-go/kafka"]
	checks := `package main

import (
	"context"

	"leetbuild/harness"
)

func CheckCompiles(ctx *harness.Ctx) { _ = relayOnce; _ = run; _ = context.Background }
`
	names := []string{"CheckCompiles"}
	if !kafkaModel {
		// With the stand-in writer the relay runs: every row is delivered and marked sent.
		checks = `package main

import (
	"context"

	"github.com/segmentio/kafka-go"

	"leetbuild/harness"
)

func CheckRelayOnce(ctx *harness.Ctx) {
	ctx.DB.Reset("CREATE TABLE outbox (id text);")
	n, err := relayOnce(context.Background())
	ctx.NoError(err, "relayOnce")
	ctx.Equal(n, 3, "delivered rows")
	ctx.Equal(len(kafka.Written), 3, "records written")
	ctx.Equal(string(kafka.Written[0].Key), "m-1", "keyed by merchant")
	ctx.Equal(kafka.Written[2].Topic, "refunds", "each row to its topic")
	ctx.Equal(string(kafka.Written[2].Value), "{\"event_id\":\"e3\"}", "the payload is the value")
	ctx.Equal(ctx.DB.Events(), []string{"BEGIN", "COMMIT"}, "one transaction")
	qs := ctx.DB.Queries()
	ctx.Equal(qs[len(qs)-2].Args, []any{"{\"e1\",\"e2\",\"e3\"}"}, "delivered rows are marked, as a pq.Array")
}
`
		names = []string{"CheckRelayOnce"}
	}
	fake := runChecks(t, "02-merchant-payments/steps/4-outbox-relay.ts", "src/payments/db/db.go", paymentsDB, checks,
		func(st pq.BackendStatement) (pq.BackendResult, error) {
			if strings.HasPrefix(st.SQL, "SELECT") {
				return pqfake.Rows([]pq.BackendColumn{pqfake.Col("id", pqfake.Text), pqfake.Col("topic", pqfake.Text),
					pqfake.Col("key", pqfake.Text), pqfake.Col("payload", pqfake.Text)},
					[]any{"e1", "payments", "m-1", `{"event_id":"e1"}`},
					[]any{"e2", "payments", "m-2", `{"event_id":"e2"}`},
					[]any{"e3", "refunds", "m-1", `{"event_id":"e3"}`}), nil
			}
			return pqfake.Affected(1), nil
		}, names...)
	if !kafkaModel {
		sts := fake.Statements()
		if len(sts) != 4 || !strings.Contains(sts[1].SQL, "SKIP LOCKED") || !reflect.DeepEqual(sts[1].Args, []any{"100"}) {
			t.Fatalf("statements %+v", sts)
		}
	}
}

func TestCourseDiscordPostMessage(t *testing.T) {
	runChecks(t, "12-discord-messages/steps/1-post-message.ts", "src/discord/db/db.go", discordDB, `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"
)

func CheckStore(ctx *harness.Ctx) {
	msg, err := storeMessage(context.Background(), 1234567890123456789, 7, "hello")
	ctx.NoError(err, "storeMessage")
	qs := ctx.DB.Queries()
	ctx.Equal(len(qs), 1, "one insert")
	id, _ := strconv.ParseInt(msg.ID, 10, 64)
	ctx.Equal(qs[0].Args, []any{int64(1234567890123456789), int64(msg.Bucket), id, int64(7), "hello"}, "insert args")
	ctx.Equal(len(ctx.DB.Events()), 0, "autocommit: no transaction")
}
`, func(st pq.BackendStatement) (pq.BackendResult, error) { return pqfake.Affected(1), nil }, "CheckStore")
}

func TestCourseDiscordReadMessages(t *testing.T) {
	runChecks(t, "12-discord-messages/steps/2-read-messages.ts", "src/discord/db/db.go", discordDB, `package main

import (
	"context"

	"leetbuild/harness"
)

func CheckFetchBucket(ctx *harness.Ctx) {
	page, err := fetchBucket(context.Background(), 42, 3, 9007199254740993, 2)
	ctx.NoError(err, "fetchBucket")
	ctx.Equal(len(page), 2, "rows")
	ctx.Equal(page[0].ID, "9007199254740992", "64-bit ids survive")
	ctx.Equal(page[1].AuthorID, "7", "author")
	ctx.Equal(page[1].Content, "older", "content")
	ctx.Equal(ctx.DB.Queries()[0].Args, []any{int64(42), int64(3), int64(9007199254740993), int64(2)}, "bucket query args")
}
`, func(st pq.BackendStatement) (pq.BackendResult, error) {
		return pqfake.Rows([]pq.BackendColumn{pqfake.Col("message_id", pqfake.Int8), pqfake.Col("author_id", pqfake.Int8),
			pqfake.Col("content", pqfake.Text)},
			[]any{"9007199254740992", "7", "newer"}, []any{"9007199254740001", "7", "older"}), nil
	}, "CheckFetchBucket")
}

func TestCourseExactlyOnceLedger(t *testing.T) {
	runChecks(t, "13-stripe-ledger/steps/4-exactly-once-ledger.ts", "src/ledger/db/db.go", ledgerDB, `package main

import (
	"context"

	"leetbuild/harness"
)

func CheckDuplicateAndRollback(ctx *harness.Ctx) {
	dup := "evt-dup"
	id, err := writeTransaction(context.Background(), []Entry{{"cash", "EUR", 100}, {"revenue", "EUR", -100}}, "seed", &dup, 1700000000000, nil)
	ctx.NoError(err, "a redelivery is not an error")
	ctx.Equal(id, "", "a redelivered event returns no id")
	ctx.Equal(ctx.DB.Events(), []string{"BEGIN", "COMMIT"}, "one transaction")
	qs := ctx.DB.Queries()
	ctx.Equal(qs[1].Args[1:], []any{"evt-dup", "seed", nil, int64(1700000000000)}, "*string args: value and nil")

	bad := "evt-bad"
	_, err = writeTransaction(context.Background(), []Entry{{"cash", "EUR", 7777}, {"revenue", "EUR", -7777}}, "seed", &bad, 1700000000000, nil)
	ctx.Assert(err != nil, "the failed entry insert must surface")
	events := ctx.DB.Events()
	ctx.Equal(events[len(events)-1], "ROLLBACK", "the failed write rolls back")
}
`, func(st pq.BackendStatement) (pq.BackendResult, error) {
		if strings.Contains(st.SQL, "ON CONFLICT") && reflect.DeepEqual(st.Args[1], "evt-dup") {
			return pqfake.Affected(0), nil
		}
		if err := failOn(st, "INSERT INTO entries", "7777", "23514"); err != nil {
			return pq.BackendResult{}, err
		}
		return pqfake.Affected(1), nil
	}, "CheckDuplicateAndRollback")
}

func TestCourseBalanceService(t *testing.T) {
	runChecks(t, "13-stripe-ledger/steps/6-balance-service.ts", "src/ledger/db/db.go", ledgerDB, `package main

import (
	"context"

	"leetbuild/harness"
)

func CheckSumEntries(ctx *harness.Ctx) {
	amount, n, err := sumEntries(context.Background(), "cash:acquirer", "EUR", 1700000001000)
	ctx.NoError(err, "sumEntries")
	ctx.Equal(amount, 3499, "balance")
	ctx.Equal(n, 4, "entries")
	ctx.Equal(ctx.DB.Queries()[0].Args, []any{"EUR", int64(1700000001000), "cash:acquirer"}, "args")
}
`, func(st pq.BackendStatement) (pq.BackendResult, error) {
		return pqfake.Rows([]pq.BackendColumn{pqfake.Col("coalesce", pqfake.Int8), pqfake.Col("count", pqfake.Int8)},
			[]any{"3499", "4"}), nil
	}, "CheckSumEntries")
}
