package vclock

import (
	"context"
	"sync"
	"time"
)

// WithDeadline is context.WithDeadline on the virtual clock: Deadline reports d, and the context
// ends with context.DeadlineExceeded once virtual time reaches it.
func WithDeadline(parent context.Context, d time.Time) (context.Context, context.CancelFunc) {
	return WithDeadlineCause(parent, d, nil)
}

// WithDeadlineCause is WithDeadline whose expiry records cause (context.Cause) instead of
// context.DeadlineExceeded.
func WithDeadlineCause(parent context.Context, d time.Time, cause error) (context.Context, context.CancelFunc) {
	if cur, ok := parent.Deadline(); ok && cur.Before(d) {
		// The parent ends sooner: a plain cancel scope keeps its deadline (and its error).
		return context.WithCancel(parent)
	}
	c := &deadlineCtx{parent: parent, deadline: d, done: make(chan struct{})}
	if parent.Done() != nil {
		stop := context.AfterFunc(parent, func() { c.end(parent.Err(), context.Cause(parent)) })
		c.addStop(func() { stop() })
	}
	if cause == nil {
		cause = context.DeadlineExceeded
	}
	if dur := Until(d); dur <= 0 {
		c.end(context.DeadlineExceeded, cause)
	} else {
		timer := AfterFunc(dur, func() { c.end(context.DeadlineExceeded, cause) })
		c.addStop(func() { timer.Stop() })
	}
	return c, func() { c.end(context.Canceled, context.Canceled) }
}

// addStop registers what end must stop; when the context already ended, it stops it now.
func (c *deadlineCtx) addStop(stop func()) {
	c.mu.Lock()
	if c.err == nil {
		c.stops = append(c.stops, stop)
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	stop()
}

// WithTimeout is WithDeadline(parent, Now().Add(timeout)).
func WithTimeout(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	return WithDeadline(parent, Now().Add(timeout))
}

// WithTimeoutCause is WithDeadlineCause(parent, Now().Add(timeout), cause).
func WithTimeoutCause(parent context.Context, timeout time.Duration, cause error) (context.Context, context.CancelFunc) {
	return WithDeadlineCause(parent, Now().Add(timeout), cause)
}

// deadlineCtx is a cancel scope with a virtual deadline, built on its own Done channel. That
// matters: the standard library's cancel propagation then reaches children through Done and Err
// (a child of an expired deadlineCtx reports DeadlineExceeded), instead of attaching them to some
// cancelCtx inside, whose error would be Canceled.
type deadlineCtx struct {
	parent   context.Context
	deadline time.Time
	done     chan struct{}

	mu    sync.Mutex
	err   error
	cause error
	stops []func()
}

func (c *deadlineCtx) end(err, cause error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	if cause == nil {
		cause = err
	}
	c.err, c.cause = err, cause
	stops := c.stops
	c.stops = nil
	close(c.done)
	c.mu.Unlock()
	for _, stop := range stops {
		stop()
	}
}

func (c *deadlineCtx) Deadline() (time.Time, bool) { return c.deadline, true }
func (c *deadlineCtx) Done() <-chan struct{}       { return c.done }

func (c *deadlineCtx) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Cause is what ended the context (context.Cause cannot see inside this type, so it is exposed for
// the runtime's own use).
func (c *deadlineCtx) Cause() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cause
}

func (c *deadlineCtx) Value(key any) any { return c.parent.Value(key) }

func (c *deadlineCtx) String() string { return "context.WithDeadline(" + c.deadline.String() + ")" }
