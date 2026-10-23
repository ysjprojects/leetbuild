package vclock

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestFakeTimersContextsAndTickers(t *testing.T) {
	c := NewFake()
	Set(c)
	defer Set(Real{})
	start := c.Now()

	timer := NewTimer(2 * time.Second)
	ticks := NewTicker(time.Second)
	ctx, cancel := WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	if d, ok := ctx.Deadline(); !ok || !d.Equal(start.Add(1500*time.Millisecond)) {
		t.Fatalf("deadline %v %v", d, ok)
	}
	c.Advance(time.Second)
	select {
	case <-ticks.C:
	default:
		t.Fatal("the ticker did not tick at 1 s")
	}
	if ctx.Err() != nil {
		t.Fatal("the context ended before its deadline")
	}
	c.Advance(time.Second)
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("ctx.Err() = %v at 2 s, want DeadlineExceeded", ctx.Err())
	}
	select {
	case at := <-timer.C:
		if !at.Equal(start.Add(2 * time.Second)) {
			t.Fatalf("timer fired at %v", at.Sub(start))
		}
	default:
		t.Fatal("the 2 s timer did not fire")
	}
	if timer.Reset(time.Second) {
		t.Fatal("Reset of a fired timer reported it active")
	}
	if !timer.Stop() {
		t.Fatal("Stop of a re-armed timer reported it inactive")
	}
	if c.Pending() != 0 {
		t.Fatalf("%d one-shot timers still pending", c.Pending())
	}
	ticks.Stop()
}

func TestChildrenOfAVirtualDeadlineReportDeadlineExceeded(t *testing.T) {
	clock := NewFake()
	Set(clock)
	defer Set(Real{})
	parent, cancelParent := WithTimeout(context.Background(), time.Second)
	defer cancelParent()
	child, cancelChild := context.WithCancel(parent)
	defer cancelChild()
	longer, cancelLonger := WithTimeout(parent, time.Hour)
	defer cancelLonger()
	clock.Advance(2 * time.Second)
	<-child.Done()
	<-longer.Done()
	for name, ctx := range map[string]context.Context{"parent": parent, "child": child, "longer": longer} {
		if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			t.Fatalf("%s.Err() = %v, want DeadlineExceeded", name, ctx.Err())
		}
	}
	explicit, cancel := WithTimeout(context.Background(), time.Minute)
	cancel()
	if !errors.Is(explicit.Err(), context.Canceled) {
		t.Fatalf("cancelled scope: %v, want Canceled", explicit.Err())
	}
}
