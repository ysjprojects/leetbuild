package harness

import (
	"testing"
	"time"

	"leetbuild/goruntime/models/kafka/kafkatest"
	"leetbuild/goruntime/vclock"
)

// A drain that starts once the check's sleep budget is spent still runs fn until the world settles,
// as a Python loop runs to its next sleep past the limit, instead of returning before fn ran.
func TestDrainAfterTheBudgetIsSpentStillRunsFn(t *testing.T) {
	clock := kafkatest.New()
	clock.SetBudget(1)
	vclock.Set(clock)
	stop := clock.Start()
	defer func() {
		stop()
		vclock.Set(vclock.Real{})
	}()
	ctx := New(clock)
	if ctx.Drain(func() {
		for {
			vclock.Sleep(time.Second)
		}
	}) {
		t.Fatal("a loop that sleeps forever returned")
	}
	select {
	case <-clock.Interrupted():
	default:
		t.Fatal("the first drain ended before the budget was spent")
	}
	ran := false
	if !ctx.Drain(func() { ran = true }) || !ran {
		t.Fatal("a drain after the budget was spent returned before fn ran")
	}
}

func TestEqualComparesNumbersByValueAtAnyDepth(t *testing.T) {
	cases := []struct {
		got, want any
		equal     bool
	}{
		{1, int64(1), true},
		{[]any{1, "a"}, []any{int64(1), "a"}, true},
		{map[string]any{"n": 2, "xs": []any{1.0}}, map[string]any{"n": 2.0, "xs": []any{uint8(1)}}, true},
		{[]any{1}, []any{"1"}, false},
		{[]any{1, 2}, []any{1}, false},
		{map[string]any{"n": 1}, map[string]any{"m": 1}, false},
		{[]string(nil), []string{}, false},
		{nil, []string(nil), false},
		{nil, nil, true},
	}
	for _, c := range cases {
		if got := equal(c.got, c.want); got != c.equal {
			t.Errorf("equal(%#v, %#v) = %v, want %v", c.got, c.want, got, c.equal)
		}
	}
}
