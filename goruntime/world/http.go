package world

import (
	"net/http"
	"sync"
)

// HTTPServer is a server the learner's code started listening with: what it serves and how.
type HTTPServer struct {
	Addr     string
	Handler  http.Handler
	TLS      bool
	CertFile string
	KeyFile  string
	// Server is the learner's own *http.Server-shaped value when they built one (TLSConfig, timeouts).
	Server any

	once    sync.Once
	stopped chan struct{}

	mu       sync.Mutex
	inflight int
	idle     chan struct{} // closed while no request is in flight
}

// Stopped is closed when the server is shut down (or the world resets).
func (s *HTTPServer) Stopped() <-chan struct{} { return s.stopped }

// Stop shuts the server down: its ListenAndServe returns http.ErrServerClosed.
func (s *HTTPServer) Stop() { s.once.Do(func() { close(s.stopped) }) }

// Closed reports whether the server stopped listening.
func (s *HTTPServer) Closed() bool {
	select {
	case <-s.stopped:
		return true
	default:
		return false
	}
}

// Begin counts a request in flight (the harness's, to a program's server) until end is called.
func (s *HTTPServer) Begin() (end func()) {
	s.mu.Lock()
	if s.inflight == 0 {
		s.idle = make(chan struct{})
	}
	s.inflight++
	s.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.inflight--; s.inflight == 0 {
				close(s.idle)
			}
		})
	}
}

// Idle is closed while no request is in flight.
func (s *HTTPServer) Idle() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.idle
}

type httpRegistry struct {
	mu      sync.Mutex
	servers []*HTTPServer
	changed chan struct{}
	mux     *http.ServeMux
}

// DefaultMux is the check's http.DefaultServeMux: fresh per check, so a handler registered by one
// check's program never collides with the next one's.
func (r *httpRegistry) DefaultMux() *http.ServeMux {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.mux == nil {
		r.mux = http.NewServeMux()
	}
	return r.mux
}

// HTTP holds the servers the learner's code is listening with in this check.
var HTTP = &httpRegistry{changed: make(chan struct{})}

// Register records a server and returns it (its Stopped channel is what the listen call waits on).
func (r *httpRegistry) Register(s *HTTPServer) *HTTPServer {
	s.stopped = make(chan struct{})
	s.idle = make(chan struct{})
	close(s.idle)
	r.mu.Lock()
	r.servers = append(r.servers, s)
	close(r.changed)
	r.changed = make(chan struct{})
	r.mu.Unlock()
	return s
}

// Servers lists the servers registered so far, in order.
func (r *httpRegistry) Servers() []*HTTPServer {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*HTTPServer(nil), r.servers...)
}

func (r *httpRegistry) reset() {
	r.mu.Lock()
	servers := r.servers
	r.servers = nil
	r.mux = nil
	r.mu.Unlock()
	for _, s := range servers {
		s.Stop()
	}
}
