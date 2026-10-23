package yaegitest

import (
	"reflect"
	"testing"
	"time"

	"leetbuild/goruntime/harness"
	"leetbuild/goruntime/vclock"
)

type host struct{}

func (host) Settle()                      {}
func (host) Interrupted() <-chan struct{} { return nil }

func TestInterpretedCodeRunsOnTheVirtualClock(t *testing.T) {
	clock := vclock.NewFake()
	vclock.Set(clock)
	defer vclock.Set(vclock.Real{})

	i, err := Compile(map[string]string{
		"src/main/app.go": `package main

import (
	"context"
	"time"
)

func wait(ctx context.Context) (time.Duration, error) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	select {
	case <-time.After(5 * time.Second):
		return time.Since(start), nil
	case <-ctx.Done():
		return time.Since(start), ctx.Err()
	}
}
`,
		"src/main/harness_test.go": `package main

import (
	"context"
	"errors"
	"time"

	"leetbuild/harness"
)

func CheckDeadline(ctx *harness.Ctx) {
	waited, err := wait(context.Background())
	ctx.Assert(errors.Is(err, context.DeadlineExceeded), "wait must end at its 2 s deadline, got %v", err)
	ctx.Equal(waited, 2*time.Second, "waited")
}
`,
	})
	if err != nil {
		t.Fatal(err)
	}
	check, err := i.Func("CheckDeadline")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan any, 1)
	go func() {
		defer func() { done <- recover() }()
		check.Call([]reflect.Value{reflect.ValueOf(harness.New(host{}))})
	}()
	// The check is blocked on its virtual timers: let it reach them, then move time.
	time.Sleep(20 * time.Millisecond)
	clock.Advance(2 * time.Second)
	select {
	case r := <-done:
		if r != nil {
			t.Fatalf("check failed: %v", r)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the check did not finish after the clock passed its deadline")
	}
}
