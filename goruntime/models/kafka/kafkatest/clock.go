// Package kafkatest is a settling virtual clock for the Kafka models' native tests: it behaves like
// the runtime's host clock — while a sleep (one-shot timer) is pending and the goroutines under
// test are blocked, virtual time jumps to the earliest one and fires it; intervals fire only as time
// passes; a jump budget ends loops that never stop — and it implements harness.Host, so a test can
// run a check against a real harness.Ctx. "Blocked" is approximated by a short real pause.
package kafkatest

import (
	"sort"
	"sync"
	"time"
)

// Clock is a vclock.Clock and a harness.Host.
type Clock struct {
	mu          sync.Mutex
	now         time.Time
	seq         int
	timers      []*timer
	jumps       int
	budget      int
	interrupted chan struct{}
	once        sync.Once
}

type timer struct {
	at       time.Time
	every    time.Duration
	seq      int
	f        func()
	canceled bool
}

// New starts at 2026-01-01 00:00:00 UTC with a budget of 500 jumps.
func New() *Clock {
	return &Clock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), budget: 500, interrupted: make(chan struct{})}
}

func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *Clock) AfterFunc(d time.Duration, f func()) func() bool {
	if d <= 0 {
		go f()
		return func() bool { return false }
	}
	t := c.add(d, 0, f)
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		if t.canceled {
			return false
		}
		t.canceled = true
		return true
	}
}

func (c *Clock) Every(d time.Duration, f func()) func() {
	t := c.add(d, d, f)
	return func() {
		c.mu.Lock()
		t.canceled = true
		c.mu.Unlock()
	}
}

func (c *Clock) add(d, every time.Duration, f func()) *timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	t := &timer{at: c.now.Add(d), every: every, seq: c.seq, f: f}
	c.timers = append(c.timers, t)
	return t
}

func (c *Clock) sortLocked() {
	live := c.timers[:0]
	for _, t := range c.timers {
		if !t.canceled {
			live = append(live, t)
		}
	}
	c.timers = live
	sort.SliceStable(c.timers, func(i, j int) bool {
		if !c.timers[i].at.Equal(c.timers[j].at) {
			return c.timers[i].at.Before(c.timers[j].at)
		}
		return c.timers[i].seq < c.timers[j].seq
	})
}

// Advance moves time forward by d, firing what falls due on the way (each callback on the caller's
// goroutine, then a pause so the goroutines it woke run).
func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	target := c.now.Add(d)
	c.mu.Unlock()
	c.advanceTo(target)
}

func (c *Clock) advanceTo(target time.Time) {
	for {
		c.mu.Lock()
		c.sortLocked()
		if len(c.timers) == 0 || c.timers[0].at.After(target) {
			if target.After(c.now) {
				c.now = target
			}
			c.mu.Unlock()
			return
		}
		t := c.timers[0]
		if t.at.After(c.now) {
			c.now = t.at
		}
		if t.every > 0 {
			t.at = t.at.Add(t.every)
		} else {
			t.canceled = true
		}
		f := t.f
		c.mu.Unlock()
		f()
		quiesce()
	}
}

func (c *Clock) nextSleep() (time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sortLocked()
	for _, t := range c.timers {
		if t.every == 0 {
			return t.at, true
		}
	}
	return time.Time{}, false
}

func quiesce() { time.Sleep(3 * time.Millisecond) }

// Start drives the clock in the background until the returned stop is called.
func (c *Clock) Start() (stop func()) {
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			default:
			}
			quiesce()
			at, ok := c.nextSleep()
			if !ok {
				continue
			}
			c.mu.Lock()
			if c.jumps >= c.budget {
				c.mu.Unlock()
				c.once.Do(func() { close(c.interrupted) })
				continue
			}
			c.jumps++
			c.mu.Unlock()
			c.advanceTo(at)
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}

// Settle returns once no sleep has been pending for a while (the driver jumps to the pending ones),
// or the budget is spent.
func (c *Clock) Settle() {
	quiet := 0
	for quiet < 10 {
		quiesce()
		select {
		case <-c.interrupted:
			return
		default:
		}
		if _, ok := c.nextSleep(); ok {
			quiet = 0
			continue
		}
		quiet++
	}
}

// Interrupted is closed once the jump budget is spent.
func (c *Clock) Interrupted() <-chan struct{} { return c.interrupted }

// SetBudget changes the jump budget (500 by default, the runtime's sleep budget per check).
func (c *Clock) SetBudget(n int) {
	c.mu.Lock()
	c.budget = n
	c.mu.Unlock()
}

// Jumps counts the sleeps the driver jumped to.
func (c *Clock) Jumps() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.jumps
}
