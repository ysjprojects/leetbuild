package world

import (
	"bytes"
	"runtime"
	"strconv"
	"sync"
)

// drains are the goroutines ctx.Drain runs the harness's loops on, by goroutine id, while the loop
// runs. Python's ctx.drain and the TypeScript one end a consumer loop once its topics are drained
// (poll raises, kafkajs's run() returns); a Go loop cannot be ended from outside, so the models
// ask InDrain whether a wait belongs to such a loop.
type drains struct {
	mu  sync.Mutex
	ids map[uint64]bool
}

// Drains are the check's drain loops.
var Drains = &drains{ids: map[uint64]bool{}}

func (d *drains) reset() {
	d.mu.Lock()
	d.ids = map[uint64]bool{}
	d.mu.Unlock()
}

// Run runs f on the calling goroutine as a drain loop: until f returns, InDrain reports true there
// (not on the goroutines f starts), across every later ctx.Drain of the check too.
func (d *drains) Run(f func()) {
	id := goroutineID()
	d.mu.Lock()
	d.ids[id] = true
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.ids, id)
		d.mu.Unlock()
	}()
	f()
}

// InDrain reports whether the calling goroutine runs a loop ctx.Drain started.
func (d *drains) InDrain() bool {
	d.mu.Lock()
	none := len(d.ids) == 0
	d.mu.Unlock()
	if none {
		return false
	}
	id := goroutineID()
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.ids[id]
}

// goroutineID is the calling goroutine's id, from the header of its stack trace
// ("goroutine 18 [running]:"); ids are never reused.
func goroutineID() uint64 {
	var buf [64]byte
	header := bytes.TrimPrefix(buf[:runtime.Stack(buf[:], false)], []byte("goroutine "))
	if i := bytes.IndexByte(header, ' '); i >= 0 {
		header = header[:i]
	}
	id, err := strconv.ParseUint(string(header), 10, 64)
	if err != nil {
		panic("world: unreadable goroutine id in " + strconv.Quote(string(buf[:])))
	}
	return id
}
