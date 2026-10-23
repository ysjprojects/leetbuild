// Package harness is what a Go harness programs against. A step's Go harness is a file in the
// learner's package (package main, compiled beside the learner's file as harness_test.go) with one
// exported check per entry of the step's checks: `check-id` → `func CheckCheckId(ctx *harness.Ctx)`.
// Each check runs in a world reset before it — empty Redis, empty broker, no gRPC peers, a fresh
// database connection, the clock at zero with a sleep budget — and in a fresh interpreter, so the
// learner's package-level state starts over. Checks grade outcomes (what Redis holds, what the
// broker holds, what the server answered), never the learner's source. They call the learner's
// functions directly: the harness is in the same package.
//
//	ctx.Fatalf / Assert / Equal / NoError / ErrorIs   fail the check with a message
//	ctx.Redis      the server, synchronously: Get, Set, PTTL, Keys("*"), HGetAll, Do("CMD", args…) …;
//	               After(key, fn) runs fn right after the first command touching key, before its
//	               caller sees the reply; Subscribe; RoundTrips
//	ctx.Kafka      the broker: CreateTopic, Seed, SeedPartition, Records, Values, Keys, EndOffset, Lag,
//	               Committed, CommittedOffset, Commits, Commit, OnCommit, OnSubscribe, FailNext, Stall,
//	               StallFor, Resume, LoseAcks, Failover, Events, EventsOf, Consumers, Flushes
//	ctx.GRPC       peers: pb.RegisterXServer(ctx.GRPC.Server(target), impl); Stop, SetLatency, Fail,
//	               ClearFailures, CallsTo, Calls, LearnerCalls, Serving; Dial for calls into the learner
//	ctx.DB         Postgres: Reset(schema), Exec, Query, Run, Events, Queries, After(pattern, fn)
//	ctx.Clock      Advance(seconds), AdvanceBy(d), Now() (ms), Time(), Sleeps()
//	ctx.Main(main) run the learner's main in the background; returns once the world settles. The
//	               *Program: HTTP(), HTTPAt(addr), Signal(sig), Exited(), Running(), Servers()
//	ctx.HTTP(h)    in-process HTTP against a handler: From(addr), Get/Head/Options/Delete/Post/Put/Patch/Do
//	               → *Response{Status, Header, Body} with Text(), JSON(), Decode(&v)
//	ctx.Instance() another instance of the program (a second process: fresh package state, its own
//	               pid) in the same world; b.Get("name") reaches its functions and variables
//	ctx.Drain(fn)  run fn until it returns or the world settles (every goroutine blocked, no sleep pending)
//	ctx.Settle()   let background goroutines run until the world settles
//	harness.Show(v) a value as messages quote it
package harness

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
)

// Host is what the runtime gives a check: the moments only the host can see.
type Host interface {
	// Settle blocks until every goroutine but the caller is blocked and no sleep is pending.
	Settle()
	// Interrupted is closed once the check's sleep budget is spent (its loops stay suspended).
	Interrupted() <-chan struct{}
}

// Ctx is the check's handle on the world.
type Ctx struct {
	Redis *Redis
	Kafka *Kafka
	GRPC  *GRPC
	DB    *DB
	Clock *Clock

	host Host
}

// New is called by the runtime once per check, after the world was reset.
func New(host Host) *Ctx {
	c := &Ctx{host: host}
	c.Redis = newRedis(c)
	c.Kafka = newKafka(c)
	c.GRPC = newGRPC(c)
	c.DB = newDB(c)
	c.Clock = newClock(c)
	return c
}

// Failure is what a failed assertion panics with; the runtime reports Message as the check's verdict.
type Failure struct{ Message string }

func (f Failure) Error() string { return f.Message }

// Fatalf fails the check now with the formatted message.
func (c *Ctx) Fatalf(format string, args ...any) {
	panic(Failure{Message: fmt.Sprintf(format, args...)})
}

// Assert fails the check with the message unless cond holds.
func (c *Ctx) Assert(cond bool, format string, args ...any) {
	if !cond {
		c.Fatalf(format, args...)
	}
}

// Equal fails the check unless got and want are deeply equal (numbers compare by value across
// int/float types); the message gets ": got X, want Y" appended.
func (c *Ctx) Equal(got, want any, format string, args ...any) {
	if equal(got, want) {
		return
	}
	msg := fmt.Sprintf(format, args...)
	if msg == "" {
		msg = "values differ"
	}
	c.Fatalf("%s: got %s, want %s", msg, Show(got), Show(want))
}

// NoError fails the check if err is not nil; the message gets ": <err>" appended.
func (c *Ctx) NoError(err error, format string, args ...any) {
	if err == nil {
		return
	}
	msg := fmt.Sprintf(format, args...)
	if msg == "" {
		msg = "unexpected error"
	}
	c.Fatalf("%s: %v", msg, err)
}

// ErrorIs fails the check unless errors.Is(err, target).
func (c *Ctx) ErrorIs(err, target error, format string, args ...any) {
	if errors.Is(err, target) {
		return
	}
	msg := fmt.Sprintf(format, args...)
	if msg == "" {
		msg = "wrong error"
	}
	c.Fatalf("%s: got %v, want %v", msg, err, target)
}

// Settle lets every goroutine the learner started run until the world settles: the clock jumps to
// pending sleeps and timers, firing them, until none is left.
func (c *Ctx) Settle() { c.host.Settle() }

// Tick lets every goroutine run until each is blocked, the clock held where it is: pending sleeps
// and timers stay pending (the TypeScript harness's `await tick()`). After a signal, Tick lets the
// program react (stop listening, start its drain timer) without the drain deadline passing.
func (c *Ctx) Tick() {
	if t, ok := c.host.(interface{ Tick() }); ok {
		t.Tick()
		return
	}
	c.host.Settle()
}

// Drain runs fn (typically the learner's consume loop) until it returns, the world settles while it
// is still running (it waits for input that will not come), or the sleep budget ends it. It reports
// whether fn returned.
func (c *Ctx) Drain(fn func()) bool {
	done := make(chan any, 1)
	go func() {
		defer func() { done <- recover() }()
		fn()
	}()
	settled := make(chan struct{})
	go func() {
		c.host.Settle()
		close(settled)
	}()
	select {
	case r := <-done:
		if r != nil {
			panic(r)
		}
		return true
	case <-settled:
		select {
		case r := <-done:
			if r != nil {
				panic(r)
			}
			return true
		default:
			return false
		}
	case <-c.host.Interrupted():
		return false
	}
}

// Show renders a value for a message: strings quoted, byte slices as text, nil as nil.
func Show(v any) string {
	switch x := v.(type) {
	case nil:
		return "nil"
	case string:
		return fmt.Sprintf("%q", x)
	case []byte:
		return fmt.Sprintf("%q", string(x))
	case error:
		return x.Error()
	case []string:
		parts := make([]string, len(x))
		for i, s := range x {
			parts[i] = fmt.Sprintf("%q", s)
		}
		return "[" + strings.Join(parts, " ") + "]"
	}
	return fmt.Sprintf("%v", v)
}

// equal is reflect.DeepEqual with numbers compared by value across int, uint and float types, at
// any depth: in slices, arrays, map values and interface values ([]any{1} equals []any{int64(1)}).
func equal(got, want any) bool {
	return equalValues(reflect.ValueOf(got), reflect.ValueOf(want))
}

func equalValues(g, w reflect.Value) bool {
	for g.IsValid() && g.Kind() == reflect.Interface && !g.IsNil() {
		g = g.Elem()
	}
	for w.IsValid() && w.Kind() == reflect.Interface && !w.IsNil() {
		w = w.Elem()
	}
	if !g.IsValid() || !w.IsValid() {
		return g.IsValid() == w.IsValid()
	}
	if gn, ok := numberOf(g); ok {
		wn, ok := numberOf(w)
		return ok && gn == wn
	}
	switch {
	case isList(g) && isList(w):
		if g.Kind() == reflect.Slice && w.Kind() == reflect.Slice && g.IsNil() != w.IsNil() {
			return false
		}
		if g.Len() != w.Len() {
			return false
		}
		for i := range g.Len() {
			if !equalValues(g.Index(i), w.Index(i)) {
				return false
			}
		}
		return true
	case g.Kind() == reflect.Map && w.Kind() == reflect.Map && g.Type().Key() == w.Type().Key():
		if g.IsNil() != w.IsNil() || g.Len() != w.Len() {
			return false
		}
		for _, k := range g.MapKeys() {
			wv := w.MapIndex(k)
			if !wv.IsValid() || !equalValues(g.MapIndex(k), wv) {
				return false
			}
		}
		return true
	}
	if g.CanInterface() && w.CanInterface() {
		return reflect.DeepEqual(g.Interface(), w.Interface())
	}
	return false
}

func isList(v reflect.Value) bool { return v.Kind() == reflect.Slice || v.Kind() == reflect.Array }

func numberOf(r reflect.Value) (float64, bool) {
	switch r.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(r.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(r.Uint()), true
	case reflect.Float32, reflect.Float64:
		return r.Float(), true
	}
	return 0, false
}
