package vclock

import (
	"sort"
	"sync"
	"time"
)

// Real is wall time: the default before a host installs its clock.
type Real struct{}

func (Real) Now() time.Time { return time.Now() }

func (Real) AfterFunc(d time.Duration, f func()) func() bool {
	return time.AfterFunc(d, f).Stop
}

func (Real) Every(d time.Duration, f func()) func() {
	ticker := time.NewTicker(d)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				go f()
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}

// Fake is a manual clock for tests: time moves only by Advance, which fires every timer and
// interval due on the way, in due order, synchronously (the callbacks this package registers never
// block). A zero-delay AfterFunc runs on its own goroutine at once, as with the real clocks.
type Fake struct {
	mu     sync.Mutex
	now    time.Time
	seq    int
	timers []*fakeTimer
}

type fakeTimer struct {
	at       time.Time
	every    time.Duration
	seq      int
	f        func()
	canceled bool
}

// NewFake starts at 2026-01-01 00:00:00 UTC.
func NewFake() *Fake { return &Fake{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)} }

func (c *Fake) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *Fake) AfterFunc(d time.Duration, f func()) func() bool {
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

func (c *Fake) Every(d time.Duration, f func()) func() {
	t := c.add(d, d, f)
	return func() {
		c.mu.Lock()
		t.canceled = true
		c.mu.Unlock()
	}
}

func (c *Fake) add(d, every time.Duration, f func()) *fakeTimer {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	t := &fakeTimer{at: c.now.Add(d), every: every, seq: c.seq, f: f}
	c.timers = append(c.timers, t)
	return t
}

// Pending counts the one-shot timers not yet fired or stopped.
func (c *Fake) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if !t.canceled && t.every == 0 {
			n++
		}
	}
	return n
}

// Advance moves the clock forward by d, firing what falls due on the way.
func (c *Fake) Advance(d time.Duration) {
	c.mu.Lock()
	target := c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
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
		if len(c.timers) == 0 || c.timers[0].at.After(target) {
			c.now = target
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
	}
}
