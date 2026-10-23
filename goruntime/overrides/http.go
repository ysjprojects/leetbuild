package overrides

import (
	"context"
	"crypto/tls"
	"log"
	"net"
	"net/http"
	"reflect"
	"sync"
	"time"

	"leetbuild/goruntime/world"
)

// Server stands in for http.Server in interpreted code, with the same exported fields: listening
// registers the server with the world (the harness sends it requests in process) instead of binding
// a port, and blocks until Shutdown, Close, or the end of the check.
type Server struct {
	Addr                         string
	Handler                      http.Handler
	DisableGeneralOptionsHandler bool
	TLSConfig                    *tls.Config
	ReadTimeout                  time.Duration
	ReadHeaderTimeout            time.Duration
	WriteTimeout                 time.Duration
	IdleTimeout                  time.Duration
	MaxHeaderBytes               int
	MaxHeaderValueCount          int
	TLSNextProto                 map[string]func(*http.Server, *tls.Conn, http.Handler)
	ConnState                    func(net.Conn, http.ConnState)
	ErrorLog                     *log.Logger
	BaseContext                  func(net.Listener) context.Context
	ConnContext                  func(ctx context.Context, c net.Conn) context.Context
	HTTP2                        *http.HTTP2Config
	Protocols                    *http.Protocols
	DisableClientPriority        bool

	mu         sync.Mutex
	registered []*world.HTTPServer
	onShutdown []func()
	closed     bool
}

func (s *Server) serve(addr string, tlsOn bool, cert, key string) error {
	handler := s.Handler
	if handler == nil {
		handler = world.HTTP.DefaultMux()
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return http.ErrServerClosed
	}
	reg := world.HTTP.Register(&world.HTTPServer{
		Addr: addr, Handler: handler, TLS: tlsOn || s.TLSConfig != nil && cert == "" && tlsOn,
		CertFile: cert, KeyFile: key, Server: s,
	})
	s.registered = append(s.registered, reg)
	s.mu.Unlock()
	<-reg.Stopped()
	return http.ErrServerClosed
}

// ListenAndServe serves on s.Addr.
func (s *Server) ListenAndServe() error { return s.serve(s.Addr, false, "", "") }

// ListenAndServeTLS serves HTTPS on s.Addr.
func (s *Server) ListenAndServeTLS(certFile, keyFile string) error {
	return s.serve(s.Addr, true, certFile, keyFile)
}

// Serve serves on the listener's address.
func (s *Server) Serve(l net.Listener) error { return s.serve(l.Addr().String(), false, "", "") }

// ServeTLS serves HTTPS on the listener's address.
func (s *Server) ServeTLS(l net.Listener, certFile, keyFile string) error {
	return s.serve(l.Addr().String(), true, certFile, keyFile)
}

// RegisterOnShutdown runs f when Shutdown is called.
func (s *Server) RegisterOnShutdown(f func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onShutdown = append(s.onShutdown, f)
}

// Shutdown stops listening at once (every listen call returns http.ErrServerClosed), starts the
// RegisterOnShutdown functions, then waits for the requests in flight: nil once none is left,
// ctx's error if ctx ends first.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	hooks := s.onShutdown
	regs := s.stop()
	s.mu.Unlock()
	for _, f := range hooks {
		world.Go(f)
	}
	for _, r := range regs {
		select {
		case <-r.Idle():
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// Close stops listening at once, without waiting for the requests in flight.
func (s *Server) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stop()
	return nil
}

// stop marks the server closed and stops its listeners (s.mu held).
func (s *Server) stop() []*world.HTTPServer {
	s.closed = true
	for _, r := range s.registered {
		r.Stop()
	}
	return s.registered
}

// SetKeepAlivesEnabled is accepted (connections are in process).
func (s *Server) SetKeepAlivesEnabled(bool) {}

// HTTP is the `net/http` listen surface for one check: the package-level listen functions, the
// Server type, and a DefaultServeMux of the check's own.
func HTTP() map[string]reflect.Value {
	mux := world.HTTP.DefaultMux()
	return map[string]reflect.Value{
		"ListenAndServe": reflect.ValueOf(func(addr string, h http.Handler) error {
			return (&Server{Addr: addr, Handler: h}).ListenAndServe()
		}),
		"ListenAndServeTLS": reflect.ValueOf(func(addr, certFile, keyFile string, h http.Handler) error {
			return (&Server{Addr: addr, Handler: h}).ListenAndServeTLS(certFile, keyFile)
		}),
		"Serve": reflect.ValueOf(func(l net.Listener, h http.Handler) error {
			return (&Server{Handler: h}).Serve(l)
		}),
		"ServeTLS": reflect.ValueOf(func(l net.Listener, h http.Handler, certFile, keyFile string) error {
			return (&Server{Handler: h}).ServeTLS(l, certFile, keyFile)
		}),
		"Server":          reflect.ValueOf((*Server)(nil)),
		"DefaultServeMux": reflect.ValueOf(&mux).Elem(),
		"Handle":          reflect.ValueOf(mux.Handle),
		"HandleFunc":      reflect.ValueOf(mux.HandleFunc),
	}
}
