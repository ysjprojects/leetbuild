// Package world is the state outside the interpreter that the overrides, the models and the harness
// share during one check, and the host's handles on what lives in JavaScript (the Redis server, the
// clock's controls, the moment the world settles). The host installs the handles once and calls
// Reset before every check.
package world

import (
	"errors"
	"reflect"
	"sync"
)

// Redis is the Redis server the runtime shares with the TypeScript one (JavaScript's SERVER).
// Arguments and bulk replies are raw bytes.
type Redis interface {
	// Execute runs one command; record is false for the harness's own commands (no round trip counted).
	Execute(args [][]byte, record bool) (Reply, error)
	// Pipeline runs commands sent in one round trip, each observed as it runs.
	Pipeline(cmds [][][]byte) []Result
	// Transaction runs a MULTI/EXEC block back to back.
	Transaction(cmds [][][]byte) []Result
	// Fingerprint is a stable rendering of key's value and expiry ("" when absent), for WATCH.
	Fingerprint(key []byte) string
	// Probe runs fn right after the first command touching key, before its caller sees the reply.
	Probe(key []byte, fn func() (any, error)) *Probe
	// Subscribe delivers every PUBLISH on channel (pattern: a PSUBSCRIBE glob) until unsubscribed.
	Subscribe(channel []byte, pattern bool, fn func(pattern, channel, message []byte)) (unsubscribe func())
	// RoundTrips lists every round trip the learner's clients made, as upper-case command names.
	RoundTrips() [][]string
}

// Reply is a Redis reply: nil, []byte (bulk), Status (simple string), int64, or []Reply.
type Reply = any

// Status is a simple-string reply (+OK).
type Status string

// ReplyError is an error reply (-ERR …).
type ReplyError struct{ Message string }

func (e *ReplyError) Error() string { return e.Message }

// Result is one command's outcome in a pipeline or transaction.
type Result struct {
	Reply Reply
	Err   error
}

// Probe records what a RedisAfter hook did.
type Probe struct {
	mu     sync.Mutex
	Fired  bool
	Result any
	Err    error
}

// Record stores the hook's outcome.
func (p *Probe) Record(result any, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Fired, p.Result, p.Err = true, result, err
}

// Clock is the clock's controls (the time itself is vclock).
type Clock interface {
	// Advance moves virtual time forward: keys expire, timers and intervals on the way fire.
	Advance(ms float64)
	// Sleeps counts the jumps virtual time made for sleeps in this check; Slept is their total (ms).
	Sleeps() int
	Slept() float64
}

// Settler tells when the world settles.
type Settler interface {
	// Settle blocks until every goroutine but the caller is blocked and no sleep is pending.
	Settle()
	// Interrupted is closed once the check's sleep budget is spent.
	Interrupted() <-chan struct{}
}

var (
	// RedisServer, ClockControl and Settle are the host's handles, installed once.
	RedisServer  Redis
	ClockControl Clock
	Settle       Settler
)

// ErrUnavailable is returned by a handle the host did not install (a native test without the JS world).
var ErrUnavailable = errors.New("not available in this runtime")

// Reset clears the per-check state kept on the Go side.
func Reset() {
	HTTP.reset()
	Process.reset()
	SpawnInstance = nil
}

// SpawnInstance starts another instance of the check's program in this world: the same build as
// a second process (fresh package state, its own pid). It returns a lookup of the instance's
// package-level names. The host sets it for each check (harness: ctx.Instance()).
var SpawnInstance func() (lookup func(name string) (reflect.Value, bool), err error)

// PanicHandler receives a panic recovered on a goroutine the runtime started to run learner code (a
// timer's function, a server handler, a consumer callback); the host fails the check with it.
var PanicHandler func(recovered any)

// Go runs f on a new goroutine whose panic is reported, never fatal to the runtime. Models start
// every goroutine that runs learner code this way.
func Go(f func()) {
	go func() {
		defer Recover()
		f()
	}()
}

// Recover reports a panic in progress; defer it directly (defer world.Recover()).
func Recover() {
	if r := recover(); r != nil {
		if PanicHandler != nil {
			PanicHandler(r)
			return
		}
		panic(r)
	}
}
