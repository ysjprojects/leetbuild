package grpc

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"

	"leetbuild/goruntime/models/grpc/codes"
	"leetbuild/goruntime/models/grpc/metadata"
	"leetbuild/goruntime/models/grpc/peer"
	"leetbuild/goruntime/models/grpc/status"
	"leetbuild/goruntime/models/netx"
	"leetbuild/goruntime/vclock"
)

type service struct {
	desc    *ServiceDesc
	impl    any
	methods map[string]*MethodDesc
	streams map[string]*StreamDesc
}

// Server serves registered services to the clients reaching it: a learner's server once it Serves
// on a listener (reached at that port), a harness peer at once (reached at its target).
type Server struct {
	opts   serverOptions
	unary  UnaryServerInterceptor
	stream StreamServerInterceptor

	peerTarget string // a harness peer's target ("" = any target); unused for learner servers

	mu        sync.Mutex
	services  map[string]*service
	listeners []net.Listener
	stopped   bool
	active    map[*rpc]struct{}
	idle      chan struct{} // closed when active empties (GracefulStop waits on it)
}

// NewServer creates a server; register services, then Serve.
func NewServer(opt ...ServerOption) *Server {
	s := &Server{services: map[string]*service{}, active: map[*rpc]struct{}{}}
	for _, o := range opt {
		o.applyServer(&s.opts)
	}
	s.unary = chainUnaryServer(s.opts.unary)
	s.stream = chainStreamServer(s.opts.stream)
	return s
}

// RegisterService registers a service and its implementation. Registering a service twice panics,
// as in grpc-go.
func (s *Server) RegisterService(sd *ServiceDesc, ss any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.services[sd.ServiceName]; dup {
		panic(fmt.Sprintf("grpc: Server.RegisterService found duplicate service registration for %q", sd.ServiceName))
	}
	svc := &service{desc: sd, impl: ss, methods: map[string]*MethodDesc{}, streams: map[string]*StreamDesc{}}
	for i := range sd.Methods {
		svc.methods[sd.Methods[i].MethodName] = &sd.Methods[i]
	}
	for i := range sd.Streams {
		svc.streams[sd.Streams[i].StreamName] = &sd.Streams[i]
	}
	s.services[sd.ServiceName] = svc
}

// GetServiceInfo describes the registered services.
func (s *Server) GetServiceInfo() map[string]ServiceInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]ServiceInfo{}
	for name, svc := range s.services {
		info := ServiceInfo{Metadata: svc.desc.Metadata}
		for _, m := range svc.desc.Methods {
			info.Methods = append(info.Methods, MethodInfo{Name: m.MethodName})
		}
		for _, st := range svc.desc.Streams {
			info.Methods = append(info.Methods, MethodInfo{Name: st.StreamName, IsClientStream: st.ClientStreams, IsServerStream: st.ServerStreams})
		}
		out[name] = info
	}
	return out
}

// Serve accepts on lis until Stop or GracefulStop (then it returns nil) or until lis fails. While
// it runs, clients dialing lis's port reach this server.
func (s *Server) Serve(lis net.Listener) error {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		_ = lis.Close()
		return ErrServerStopped
	}
	s.listeners = append(s.listeners, lis)
	s.mu.Unlock()
	key := listenerKey(lis)
	if !registerLearner(key, s) {
		return fmt.Errorf("grpc: another server already serves on %s", lis.Addr())
	}
	for {
		conn, err := lis.Accept()
		if err != nil {
			unregisterKey(key, s)
			s.mu.Lock()
			stopped := s.stopped
			s.mu.Unlock()
			if stopped {
				return nil
			}
			return err
		}
		_ = conn.Close() // there is no HTTP/2 transport: calls are routed by the registry
	}
}

func listenerKey(lis net.Listener) string {
	if l, ok := lis.(*netx.Listener); ok {
		return l.Key()
	}
	key, err := netx.Key(lis.Addr().Network(), lis.Addr().String())
	if err != nil {
		return lis.Addr().String()
	}
	return key
}

func unregisterKey(key string, s *Server) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if reg.learner[key] == s {
		delete(reg.learner, key)
	}
}

// Stop stops the server at once: listeners close, calls in flight fail UNAVAILABLE.
func (s *Server) Stop() {
	active := s.halt()
	for _, r := range active {
		r.finish(status.New(codes.Unavailable, "transport is closing"), true)
	}
}

// GracefulStop stops accepting calls and waits for the calls in flight to finish.
func (s *Server) GracefulStop() {
	s.halt()
	s.mu.Lock()
	idle := s.idle
	if len(s.active) == 0 {
		idle = nil
	}
	s.mu.Unlock()
	if idle != nil {
		<-idle
	}
}

func (s *Server) halt() []*rpc {
	s.mu.Lock()
	s.stopped = true
	listeners := s.listeners
	s.listeners = nil
	active := make([]*rpc, 0, len(s.active))
	for r := range s.active {
		active = append(active, r)
	}
	s.mu.Unlock()
	unregister(s)
	for _, l := range listeners {
		_ = l.Close()
	}
	return active
}

func (s *Server) hasService(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.services[name]
	return ok
}

// serves reports whether path's service is registered here.
func (s *Server) serves(path string) bool {
	service, _ := splitMethod(path)
	return s.hasService(service)
}

func (s *Server) lookup(path string) (impl any, md *MethodDesc, sd *StreamDesc) {
	service, method := splitMethod(path)
	s.mu.Lock()
	defer s.mu.Unlock()
	svc := s.services[service]
	if svc == nil {
		return nil, nil, nil
	}
	return svc.impl, svc.methods[method], svc.streams[method]
}

// start attaches r to this server: its context (incoming metadata, peer, the caller's deadline),
// cancellation from the caller, and the handler after latency. It reports false when stopped.
func (s *Server) start(r *rpc, md metadata.MD, latency time.Duration) bool {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return false
	}
	if len(s.active) == 0 {
		s.idle = make(chan struct{})
	}
	s.active[r] = struct{}{}
	s.mu.Unlock()
	r.server = s

	ss := &serverStream{r: r}
	ctx := metadata.NewIncomingContext(context.Background(), md.Copy())
	p := &peer.Peer{Addr: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 54321}, LocalAddr: addr(r.target)}
	if s.opts.creds != nil {
		_, p.AuthInfo, _ = s.opts.creds.ServerHandshake(nil)
	}
	ctx = peer.NewContext(ctx, p)
	ctx = context.WithValue(ctx, streamKey{}, ss)
	cancelDeadline := func() {}
	if dl, ok := r.clientCtx.Deadline(); ok {
		ctx, cancelDeadline = vclock.WithDeadline(ctx, dl)
	}
	sctx, cancel := context.WithCancel(ctx)
	r.sctx = sctx
	r.cancelServer = func() {
		cancel()
		cancelDeadline()
	}
	// The caller giving up (cancel, deadline) ends the call on both ends.
	r.stopWatch = context.AfterFunc(r.clientCtx, func() {
		r.finish(status.FromContextError(r.clientCtx.Err()), true)
	})
	r.serve(s, latency)
	return true
}

func (s *Server) untrack(r *rpc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.active[r]; !ok {
		return
	}
	delete(s.active, r)
	if len(s.active) == 0 && s.idle != nil {
		close(s.idle)
		s.idle = nil
	}
}

// ---- the handler's context -----------------------------------------------------------------------

func streamFrom(ctx context.Context) (*serverStream, error) {
	ss, ok := ctx.Value(streamKey{}).(*serverStream)
	if !ok {
		return nil, status.Errorf(codes.Internal, "grpc: failed to fetch the stream from the context %v", ctx)
	}
	return ss, nil
}

// SetHeader sets header metadata to send with the response (handler context only).
func SetHeader(ctx context.Context, md metadata.MD) error {
	if md.Len() == 0 {
		return nil
	}
	ss, err := streamFrom(ctx)
	if err != nil {
		return err
	}
	return ss.SetHeader(md)
}

// SendHeader sends header metadata now (at most once).
func SendHeader(ctx context.Context, md metadata.MD) error {
	ss, err := streamFrom(ctx)
	if err != nil {
		return err
	}
	return ss.SendHeader(md)
}

// SetTrailer sets trailer metadata sent when the call ends.
func SetTrailer(ctx context.Context, md metadata.MD) error {
	if md.Len() == 0 {
		return nil
	}
	ss, err := streamFrom(ctx)
	if err != nil {
		return err
	}
	ss.SetTrailer(md)
	return nil
}

// Method returns the full method name of the call a handler context belongs to.
func Method(ctx context.Context) (string, bool) {
	ss, err := streamFrom(ctx)
	if err != nil {
		return "", false
	}
	return ss.r.method, true
}
