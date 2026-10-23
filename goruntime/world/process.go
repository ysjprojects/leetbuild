package world

import (
	"os"
	"strconv"
	"sync"
)

// ExitPanic is what os.Exit and log.Fatal panic with in interpreted code: the program ends there,
// the runtime does not.
type ExitPanic struct {
	Code    int
	Message string
}

func (e ExitPanic) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "exit status " + strconv.Itoa(e.Code)
}

type process struct {
	mu      sync.Mutex
	subs    []subscription
	exited  bool
	code    int
	message string
}

type subscription struct {
	c    chan<- os.Signal
	sigs []os.Signal
}

// Process is the learner's process: signal subscriptions and how it exited.
var Process = &process{}

// Notify relays sigs (all of them when none are given) to c, as signal.Notify does.
func (p *process) Notify(c chan<- os.Signal, sigs ...os.Signal) {
	if c == nil {
		panic("os/signal: Notify using nil channel")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.subs = append(p.subs, subscription{c: c, sigs: sigs})
}

// Stop ends every relay to c.
func (p *process) Stop(c chan<- os.Signal) {
	p.mu.Lock()
	defer p.mu.Unlock()
	kept := p.subs[:0]
	for _, s := range p.subs {
		if s.c != c {
			kept = append(kept, s)
		}
	}
	p.subs = kept
}

// Signal delivers sig to every subscribed channel without blocking (a full channel misses it, as
// with the real os/signal) and reports how many received it.
func (p *process) Signal(sig os.Signal) int {
	p.mu.Lock()
	subs := append([]subscription(nil), p.subs...)
	p.mu.Unlock()
	n := 0
	for _, s := range subs {
		if !wants(s.sigs, sig) {
			continue
		}
		select {
		case s.c <- sig:
			n++
		default:
		}
	}
	return n
}

// Subscribed reports whether any channel would receive sig.
func (p *process) Subscribed(sig os.Signal) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range p.subs {
		if wants(s.sigs, sig) {
			return true
		}
	}
	return false
}

// Exit records the first exit (os.Exit, log.Fatal).
func (p *process) Exit(code int, message string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exited {
		return
	}
	p.exited, p.code, p.message = true, code, message
}

// Exited reports the recorded exit, if any.
func (p *process) Exited() (code int, message string, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.code, p.message, p.exited
}

func (p *process) reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.subs = nil
	p.exited, p.code, p.message = false, 0, ""
}

func wants(sigs []os.Signal, sig os.Signal) bool {
	if len(sigs) == 0 {
		return true
	}
	for _, s := range sigs {
		if s == sig {
			return true
		}
	}
	return false
}
