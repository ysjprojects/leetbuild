package harness

import (
	"time"

	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
)

// Clock is the check's control over virtual time.
type Clock struct{ ctx *Ctx }

func newClock(c *Ctx) *Clock { return &Clock{ctx: c} }

// Advance moves virtual time forward by seconds: keys expire, windows roll over, deadlines pass,
// timers and background jobs fire. Goroutines the timers woke run once the harness next waits (a
// learner call that blocks, Settle, Drain).
func (c *Clock) Advance(seconds float64) {
	if world.ClockControl == nil {
		c.ctx.Fatalf("the clock is not available in this runtime")
	}
	world.ClockControl.Advance(seconds * 1000)
}

// AdvanceBy is Advance for a duration.
func (c *Clock) AdvanceBy(d time.Duration) { c.Advance(d.Seconds()) }

// Now is the virtual time in milliseconds since the epoch (what the learner's time.Now() reads).
func (c *Clock) Now() int64 { return vclock.Now().UnixMilli() }

// Time is the virtual time.
func (c *Clock) Time() time.Time { return vclock.Now() }

// Sleeps counts the jumps virtual time made for sleeps in this check so far.
func (c *Clock) Sleeps() int {
	if world.ClockControl == nil {
		return 0
	}
	return world.ClockControl.Sleeps()
}

// SetSleepLimit sets how many jumps virtual time may make for sleeps in this check before the
// program's loops are suspended (default 500; Python's ctx.clock.sleep_limit). For checks whose
// program idles in many short sleeps, such as a consumer polling every 10 ms.
func (c *Clock) SetSleepLimit(n int) {
	control, ok := world.ClockControl.(interface{ SetSleepLimit(int) })
	if !ok {
		c.ctx.Fatalf("the clock's sleep limit cannot be set in this runtime")
	}
	control.SetSleepLimit(n)
}
