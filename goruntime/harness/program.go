package harness

import (
	"fmt"
	"os"
	"strings"

	"leetbuild/goruntime/world"
)

// Program is the learner's main, running in the background.
type Program struct {
	ctx  *Ctx
	done chan struct{}
	end  any // what main panicked with (an exit is world.ExitPanic), nil when it returned
}

// Main runs the learner's main in the background and returns once the world settles: it is
// serving, consuming, or waiting. Pass the learner's main function: ctx.Main(main).
func (c *Ctx) Main(main func()) *Program {
	p := &Program{ctx: c, done: make(chan struct{})}
	go func() {
		defer func() {
			p.end = recover()
			close(p.done)
		}()
		main()
	}()
	c.Settle()
	return p
}

// Running reports whether main has not returned (nor exited, nor panicked).
func (p *Program) Running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

// Exited reports whether the program exited (os.Exit, log.Fatal), with the code and message.
func (p *Program) Exited() (code int, message string, ok bool) { return world.Process.Exited() }

// Signal delivers sig (syscall.SIGTERM, os.Interrupt) to the channels the program subscribed with
// signal.Notify, and returns how many received it.
func (p *Program) Signal(sig os.Signal) int { return world.Process.Signal(sig) }

// Servers lists the HTTP servers the program is listening with.
func (p *Program) Servers() []*world.HTTPServer { return world.HTTP.Servers() }

// HTTP is a client of the program's HTTP server; the check fails unless main started exactly one.
// Its requests count as in flight on that server (a graceful shutdown waits for them).
func (p *Program) HTTP() *HTTP {
	servers := world.HTTP.Servers()
	if len(servers) != 1 {
		p.ctx.Fatalf("expected main to serve HTTP on one address, %s", p.describe(servers))
	}
	return p.ctx.on(servers[0])
}

// HTTPAt is a client of the program's HTTP server listening on addr (":8443" or a port "8443").
func (p *Program) HTTPAt(addr string) *HTTP {
	servers := world.HTTP.Servers()
	for _, s := range servers {
		if samePort(s.Addr, addr) {
			return p.ctx.on(s)
		}
	}
	p.ctx.Fatalf("expected main to serve HTTP on %s, %s", addr, p.describe(servers))
	return nil
}

// Listening reports whether any of the program's HTTP servers still accepts requests (a shutdown
// closes the listener at once, before the requests in flight drain).
func (p *Program) Listening() bool {
	for _, s := range world.HTTP.Servers() {
		if !s.Closed() {
			return true
		}
	}
	return false
}

// describe says what main did instead: where it listens, or how it ended.
func (p *Program) describe(servers []*world.HTTPServer) string {
	if len(servers) > 0 {
		addrs := make([]string, len(servers))
		for i, s := range servers {
			addrs[i] = s.Addr
		}
		return "it listens on " + strings.Join(addrs, ", ")
	}
	if !p.Running() {
		if p.end != nil {
			return fmt.Sprintf("but main ended: %v", p.end)
		}
		return "but main returned without listening"
	}
	return "but main is not listening (it is blocked before ListenAndServe)"
}

func samePort(a, b string) bool { return port(a) == port(b) }

func port(addr string) string {
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		return addr[i+1:]
	}
	return addr
}
