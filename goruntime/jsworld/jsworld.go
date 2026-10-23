//go:build js

// Package jsworld connects the Go side of the world to the JavaScript side the TypeScript runtime
// also uses (src/lib/runtime/go.ts installs `globalThis.__lbGo`): the virtual clock, the Redis
// server, settling and the sleep-budget interrupt. Byte strings cross as latin-1 JavaScript
// strings (one char per byte), the Redis server's own convention.
package jsworld

import (
	"math"
	"sync"
	"sync/atomic"
	"syscall/js"
	"time"
	"unicode/utf8"

	"leetbuild/goruntime/host"
	"leetbuild/goruntime/models/pq"
	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
)

// Install wires the world to bridge (globalThis.__lbGo).
func Install(bridge js.Value) {
	clock := bridge.Get("clock")
	vclock.Set(&jsClock{b: clock})
	world.ClockControl = &jsClockControl{b: clock}
	world.RedisServer = &jsRedis{b: bridge.Get("redis")}
	pq.SetBackend(&jsDB{b: bridge.Get("db")})
	s := &jsSettler{b: bridge, interrupted: make(chan struct{})}
	world.Settle = s
	host.Resets = append(host.Resets, s.rearm)
	bridge.Call("onInterrupt", js.FuncOf(func(js.Value, []js.Value) any {
		s.interrupt()
		return nil
	}))
}

// ---- byte strings --------------------------------------------------------------------------------

// ToJS is b as a latin-1 JavaScript string.
func ToJS(b []byte) js.Value {
	ascii := true
	for _, c := range b {
		if c >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return js.ValueOf(string(b))
	}
	runes := make([]rune, len(b))
	for i, c := range b {
		runes[i] = rune(c)
	}
	return js.ValueOf(string(runes))
}

// FromJS is a latin-1 JavaScript string's bytes.
func FromJS(v js.Value) []byte {
	s := v.String()
	out := make([]byte, 0, len(s))
	for _, r := range s {
		out = append(out, byte(r))
	}
	return out
}

// ---- the clock -----------------------------------------------------------------------------------

type jsClock struct{ b js.Value }

func (c *jsClock) Now() time.Time {
	ms := c.b.Call("now").Float()
	// Whole milliseconds exactly, the fraction apart: ms*1e6 at the epoch's magnitude is past float64's
	// exact integers, and its rounding shows in differences (400 ms apart coming out 399.99974 ms).
	whole := math.Floor(ms)
	return time.UnixMilli(int64(whole)).Add(time.Duration((ms - whole) * float64(time.Millisecond)))
}

func millis(d time.Duration) float64 {
	if d <= 0 {
		return 0
	}
	return float64(d) / float64(time.Millisecond)
}

func (c *jsClock) AfterFunc(d time.Duration, f func()) func() bool {
	if d <= 0 {
		// Due already: nothing to wait for. Through JavaScript it would be a setTimeout(0), which runs
		// only after the clock's next turn, and that turn jumps to any other pending sleep first.
		world.Go(f)
		return func() bool { return false }
	}
	var done atomic.Bool
	var cb js.Func
	cb = js.FuncOf(func(js.Value, []js.Value) any {
		if done.Swap(true) {
			return nil
		}
		cb.Release()
		world.Go(f)
		return nil
	})
	id := c.b.Call("setTimeout", cb, millis(d))
	return func() bool {
		if done.Swap(true) {
			return false
		}
		c.b.Call("clearTimeout", id)
		cb.Release()
		return true
	}
}

func (c *jsClock) Every(d time.Duration, f func()) func() {
	var stopped atomic.Bool
	cb := js.FuncOf(func(js.Value, []js.Value) any {
		if !stopped.Load() {
			world.Go(f)
		}
		return nil
	})
	id := c.b.Call("setInterval", cb, millis(d))
	return func() {
		if stopped.Swap(true) {
			return
		}
		c.b.Call("clearInterval", id)
		cb.Release()
	}
}

type jsClockControl struct{ b js.Value }

func (c *jsClockControl) Advance(ms float64) { c.b.Call("advance", ms) }
func (c *jsClockControl) Sleeps() int        { return c.b.Call("sleeps").Int() }
func (c *jsClockControl) Slept() float64     { return c.b.Call("slept").Float() }

// SetSleepLimit sets how many jumps the clock may make for sleeps in this check.
func (c *jsClockControl) SetSleepLimit(n int) { c.b.Call("setSleepLimit", n) }

// ---- settling ------------------------------------------------------------------------------------

type jsSettler struct {
	b           js.Value
	mu          sync.Mutex
	interrupted chan struct{}
	fired       bool
}

func (s *jsSettler) Settle() { s.await("settle") }

// Tick returns once every goroutine is blocked and nothing is in flight, the clock held where it is.
func (s *jsSettler) Tick() { s.await("tick") }

// await calls the bridge's method with a callback and blocks until JavaScript calls it back.
func (s *jsSettler) await(method string) {
	done := make(chan struct{})
	var cb js.Func
	cb = js.FuncOf(func(js.Value, []js.Value) any {
		cb.Release()
		close(done)
		return nil
	})
	s.b.Call(method, cb)
	<-done
}

func (s *jsSettler) Interrupted() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.interrupted
}

func (s *jsSettler) interrupt() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.fired {
		s.fired = true
		close(s.interrupted)
	}
}

// rearm gives the next check a fresh interrupt.
func (s *jsSettler) rearm() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.interrupted, s.fired = make(chan struct{}), false
}

// ---- Redis ---------------------------------------------------------------------------------------

type jsRedis struct{ b js.Value }

func command(args [][]byte) js.Value {
	arr := js.Global().Get("Array").New(len(args))
	for i, a := range args {
		arr.SetIndex(i, ToJS(a))
	}
	return arr
}

func commands(cmds [][][]byte) js.Value {
	arr := js.Global().Get("Array").New(len(cmds))
	for i, c := range cmds {
		arr.SetIndex(i, command(c))
	}
	return arr
}

// reply decodes a bridge reply: a latin-1 string, a number, null, or an array of those.
func reply(v js.Value) world.Reply {
	switch v.Type() {
	case js.TypeNull, js.TypeUndefined:
		return nil
	case js.TypeString:
		return FromJS(v)
	case js.TypeNumber:
		f := v.Float()
		if f == float64(int64(f)) {
			return int64(f)
		}
		return f
	case js.TypeObject:
		n := v.Length()
		out := make([]world.Reply, n)
		for i := range n {
			out[i] = reply(v.Index(i))
		}
		return out
	}
	return nil
}

// result decodes `{r: reply}` or `{e: message}`.
func result(v js.Value) (world.Reply, error) {
	if e := v.Get("e"); e.Type() == js.TypeString {
		return nil, &world.ReplyError{Message: e.String()}
	}
	return reply(v.Get("r")), nil
}

func results(v js.Value) []world.Result {
	out := make([]world.Result, v.Length())
	for i := range out {
		r, err := result(v.Index(i))
		out[i] = world.Result{Reply: r, Err: err}
	}
	return out
}

func (r *jsRedis) Execute(args [][]byte, record bool) (world.Reply, error) {
	return result(r.b.Call("execute", command(args), record))
}

func (r *jsRedis) Pipeline(cmds [][][]byte) []world.Result {
	return results(r.b.Call("pipeline", commands(cmds)))
}

func (r *jsRedis) Transaction(cmds [][][]byte) []world.Result {
	return results(r.b.Call("transaction", commands(cmds)))
}

func (r *jsRedis) Fingerprint(key []byte) string { return r.b.Call("fingerprint", ToJS(key)).String() }

func (r *jsRedis) Probe(key []byte, fn func() (any, error)) *world.Probe {
	p := &world.Probe{}
	var cb js.Func
	cb = js.FuncOf(func(js.Value, []js.Value) any {
		cb.Release()
		res, err := fn()
		p.Record(res, err)
		return nil
	})
	r.b.Call("probe", ToJS(key), cb)
	return p
}

func (r *jsRedis) Subscribe(channel []byte, pattern bool, fn func(pattern, channel, message []byte)) func() {
	cb := js.FuncOf(func(_ js.Value, args []js.Value) any {
		var pat []byte
		if args[0].Type() == js.TypeString {
			pat = FromJS(args[0])
		}
		ch, msg := FromJS(args[1]), FromJS(args[2])
		world.Go(func() { fn(pat, ch, msg) })
		return nil
	})
	stop := r.b.Call("subscribe", ToJS(channel), pattern, cb)
	var once sync.Once
	return func() {
		once.Do(func() {
			stop.Invoke()
			cb.Release()
		})
	}
}

func (r *jsRedis) RoundTrips() [][]string {
	v := r.b.Call("trips")
	out := make([][]string, v.Length())
	for i := range out {
		t := v.Index(i)
		trip := make([]string, t.Length())
		for j := range trip {
			trip[j] = t.Index(j).String()
		}
		out[i] = trip
	}
	return out
}
