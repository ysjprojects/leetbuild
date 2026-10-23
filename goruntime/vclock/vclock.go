// Package vclock is the virtual clock natively compiled runtime code runs on: the models (broker,
// gRPC, HTTP), and the `time` and `context` the interpreter gives learner code. The host installs
// the clock the whole world shares (the JavaScript one, which Redis TTLs and the learner's sleeps
// also run on); tests install a Fake. Semantics are the TypeScript runtime's: a one-shot wait is a
// sleep — when every goroutine is blocked the world jumps to the earliest one and fires it — and an
// interval never moves the clock by itself, it only fires as virtual time passes it.
package vclock

import (
	"context"
	"sync"
	"time"
)

// Clock is what a host provides.
type Clock interface {
	Now() time.Time
	// AfterFunc runs f (on its own goroutine) once d of virtual time has passed; d <= 0 runs it
	// asynchronously at once, without moving the clock. stop reports whether it stopped f.
	AfterFunc(d time.Duration, f func()) (stop func() bool)
	// Every runs f (on its own goroutine) each time virtual time passes another d.
	Every(d time.Duration, f func()) (stop func())
}

var (
	mu      sync.RWMutex
	current Clock = Real{}
)

// Set installs c as the clock every caller of this package uses.
func Set(c Clock) {
	mu.Lock()
	current = c
	mu.Unlock()
}

// Get returns the installed clock.
func Get() Clock {
	mu.RLock()
	defer mu.RUnlock()
	return current
}

// Now is the virtual time.
func Now() time.Time { return Get().Now() }

// Since is Now().Sub(t).
func Since(t time.Time) time.Duration { return Now().Sub(t) }

// Until is t.Sub(Now()).
func Until(t time.Time) time.Duration { return t.Sub(Now()) }

// Sleep blocks the calling goroutine for d of virtual time; d <= 0 returns at once.
func Sleep(d time.Duration) {
	if d <= 0 {
		return
	}
	done := make(chan struct{})
	Get().AfterFunc(d, func() { close(done) })
	<-done
}

// SleepContext sleeps for d unless ctx ends first; it returns ctx.Err() in that case.
func SleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// After sends the virtual time on the returned channel once d has passed.
func After(d time.Duration) <-chan time.Time { return NewTimer(d).C }

// Timer is time.Timer on the virtual clock.
type Timer struct {
	C <-chan time.Time
	c chan time.Time

	mu   sync.Mutex
	stop func() bool
	fn   func()
}

// NewTimer sends the virtual time on C once d has passed.
func NewTimer(d time.Duration) *Timer {
	c := make(chan time.Time, 1)
	t := &Timer{C: c, c: c}
	t.arm(d)
	return t
}

// AfterFunc calls f on its own goroutine once d has passed; Stop cancels it.
func AfterFunc(d time.Duration, f func()) *Timer {
	t := &Timer{fn: f}
	t.arm(d)
	return t
}

func (t *Timer) arm(d time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	fire := func() {
		if t.fn != nil {
			t.fn()
			return
		}
		select {
		case t.c <- Now():
		default:
		}
	}
	// A clock fires d <= 0 asynchronously at once, as time.NewTimer(0) does.
	t.stop = Get().AfterFunc(d, fire)
}

// Stop prevents the timer from firing; it reports whether the call stopped it.
func (t *Timer) Stop() bool {
	t.mu.Lock()
	stop := t.stop
	t.mu.Unlock()
	if stop == nil {
		return false
	}
	return stop()
}

// Reset re-arms the timer to fire d from now; it reports whether the timer had been active.
func (t *Timer) Reset(d time.Duration) bool {
	active := t.Stop()
	if t.c != nil {
		// Go 1.23 semantics: no stale value is received after Reset.
		select {
		case <-t.c:
		default:
		}
	}
	t.arm(d)
	return active
}

// Ticker is time.Ticker on the virtual clock: it delivers as virtual time passes each interval and
// drops ticks a slow receiver misses.
type Ticker struct {
	C <-chan time.Time
	c chan time.Time

	mu   sync.Mutex
	stop func()
}

// NewTicker delivers the virtual time on C every d. d must be positive.
func NewTicker(d time.Duration) *Ticker {
	if d <= 0 {
		panic("non-positive interval for NewTicker")
	}
	c := make(chan time.Time, 1)
	t := &Ticker{C: c, c: c}
	t.arm(d)
	return t
}

func (t *Ticker) arm(d time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.stop = Get().Every(d, func() {
		select {
		case t.c <- Now():
		default:
		}
	})
}

// Stop turns the ticker off; no more ticks are sent.
func (t *Ticker) Stop() {
	t.mu.Lock()
	stop := t.stop
	t.stop = nil
	t.mu.Unlock()
	if stop != nil {
		stop()
	}
}

// Reset stops the ticker and restarts it with interval d.
func (t *Ticker) Reset(d time.Duration) {
	if d <= 0 {
		panic("non-positive interval for Ticker.Reset")
	}
	t.Stop()
	t.arm(d)
}

// Tick is NewTicker(d).C, or nil for d <= 0.
func Tick(d time.Duration) <-chan time.Time {
	if d <= 0 {
		return nil
	}
	return NewTicker(d).C
}
