// Package grpc is google.golang.org/grpc for the in-process runtime: clients and servers talk
// through a registry instead of sockets (see registry.go), with deadlines, latency and injected
// failures on the virtual clock, metadata, interceptors and the four kinds of streams.
//
// Semantics follow grpc-go: a context's cancellation or deadline ends the call CANCELED or
// DEADLINE_EXCEEDED on both ends; a handler's non-status error becomes UNKNOWN (context errors keep
// their meaning); messages cross by deep copy, so neither side shares memory with the other.
//
// Generated code (leetbuild/goruntime/protogen) registers handlers bound to the implementation in
// closures: an interpreted value handed to native code and back loses its method set, so the
// classic `srv.(XServer)` inside a ServiceDesc's handlers only works for native implementations.
package grpc

import (
	"context"
	"errors"
	"net"
	"sync"

	"leetbuild/goruntime/models/grpc/codes"
	"leetbuild/goruntime/models/grpc/metadata"
	"leetbuild/goruntime/models/grpc/status"
	"leetbuild/goruntime/vclock"
)

// ErrClientConnClosing is a call on a closed ClientConn.
var ErrClientConnClosing = status.Error(codes.Canceled, "grpc: the client connection is closing")

// ErrServerStopped is Serve on a stopped Server.
var ErrServerStopped = errors.New("grpc: the server has been stopped")

// ClientConn is a virtual connection to a target. It never connects: each call is routed when it
// is made, so a client created before its server exists works once the server is up.
type ClientConn struct {
	target  string
	routed  string // target without its resolver scheme
	dopts   dialOptions
	harness bool

	mu     sync.Mutex
	closed bool
}

// NewClient creates a client for target ("host:port", "dns:///host:port"). Transport credentials
// are required, as in grpc-go.
func NewClient(target string, opts ...DialOption) (*ClientConn, error) {
	cc := &ClientConn{target: target, routed: normalizeTarget(target)}
	for _, o := range opts {
		o.applyDial(&cc.dopts)
	}
	if cc.dopts.creds == nil {
		return nil, errors.New("grpc: no transport security set (use grpc.WithTransportCredentials(insecure.NewCredentials()) explicitly or set credentials)")
	}
	return cc, nil
}

// Dial is NewClient. Deprecated in grpc-go; kept for older code.
func Dial(target string, opts ...DialOption) (*ClientConn, error) { return NewClient(target, opts...) }

// DialContext is NewClient (connections are ready at once).
func DialContext(ctx context.Context, target string, opts ...DialOption) (*ClientConn, error) {
	return NewClient(target, opts...)
}

// Target returns the target the client was created for.
func (cc *ClientConn) Target() string { return cc.target }

// CanonicalTarget returns the target with its resolver scheme.
func (cc *ClientConn) CanonicalTarget() string {
	if cc.routed == cc.target {
		return "dns:///" + cc.target
	}
	return cc.target
}

// Close closes the connection: later calls fail with ErrClientConnClosing.
func (cc *ClientConn) Close() error {
	cc.mu.Lock()
	defer cc.mu.Unlock()
	if cc.closed {
		return status.Error(codes.Canceled, "grpc: the client connection is closing")
	}
	cc.closed = true
	return nil
}

// Connect starts connecting (a no-op: calls are routed when made).
func (cc *ClientConn) Connect() {}

// ResetConnectBackoff resets reconnection backoff (none in-process).
func (cc *ClientConn) ResetConnectBackoff() {}

// Invoke makes a unary call: req goes to method on the server, its response lands in reply.
func (cc *ClientConn) Invoke(ctx context.Context, method string, args, reply any, opts ...CallOption) error {
	opts = append(append([]CallOption(nil), cc.dopts.callOptions...), opts...)
	return chainUnaryClient(cc.dopts.unary, invoke)(ctx, method, args, reply, cc, opts...)
}

func invoke(ctx context.Context, method string, req, reply any, cc *ClientConn, opts ...CallOption) error {
	cs, err := cc.newStream(ctx, &StreamDesc{}, method, opts, req)
	if err != nil {
		return err
	}
	if err := cs.SendMsg(req); err != nil {
		return err
	}
	if err := cs.CloseSend(); err != nil {
		return err
	}
	return cs.RecvMsg(reply)
}

// NewStream opens a stream to method.
func (cc *ClientConn) NewStream(ctx context.Context, desc *StreamDesc, method string, opts ...CallOption) (ClientStream, error) {
	opts = append(append([]CallOption(nil), cc.dopts.callOptions...), opts...)
	streamer := func(ctx context.Context, desc *StreamDesc, cc *ClientConn, method string, opts ...CallOption) (ClientStream, error) {
		return cc.newStream(ctx, desc, method, opts, nil)
	}
	return chainStreamClient(cc.dopts.stream, streamer)(ctx, desc, cc, method, opts...)
}

// newStream is the handshake every call goes through: record it (with req, a unary call's request,
// so calls failed before reaching a server log it too), inject faults, find the server,
// start its handler after the latency.
func (cc *ClientConn) newStream(ctx context.Context, desc *StreamDesc, method string, opts []CallOption, req any) (*clientStream, error) {
	cc.mu.Lock()
	closed := cc.closed
	cc.mu.Unlock()
	if closed {
		return nil, ErrClientConnClosing
	}
	var info callInfo
	for _, o := range opts {
		o.applyCall(&info)
	}
	md, _ := metadata.FromOutgoingContext(ctx)
	if md == nil {
		md = metadata.MD{}
	}
	if cc.dopts.authority != "" {
		md.Set(":authority", cc.dopts.authority)
	}
	if cc.dopts.userAgent != "" {
		md.Set("user-agent", cc.dopts.userAgent)
	}
	service, _ := splitMethod(method)
	for _, creds := range cc.dopts.perRPC {
		extra, err := creds.GetRequestMetadata(ctx, "https://"+cc.routed+"/"+service)
		if err != nil {
			return nil, status.Errorf(codes.Unauthenticated, "transport: per-RPC creds failed due to error: %v", err)
		}
		for k, v := range extra {
			md.Append(k, v)
		}
	}
	rec := &Call{Method: method, Target: cc.routed, Metadata: md.Copy(), Started: vclock.Now(), FromHarness: cc.harness}
	if req != nil {
		rec.Request = snapshot(req)
	}
	if dl, ok := ctx.Deadline(); ok {
		rec.Deadline, rec.Timeout = dl, dl.Sub(rec.Started)
	}
	record(rec)
	r := newRPC(ctx, method, cc.routed, desc, rec, info)
	if err := ctx.Err(); err != nil {
		st := status.FromContextError(err)
		r.finish(st, true)
		return nil, st.Err()
	}
	if f, ok := popFailure(method, cc.routed); ok {
		r.finish(status.New(f.code, failureDetails(f)), false)
		return &clientStream{r: r}, nil
	}
	srv, _ := resolve(method, cc.routed)
	if srv == nil {
		st := status.Newf(codes.Unavailable, "connection error: desc = \"transport: Error while dialing: nothing serves %s at %s\"", method, cc.routed)
		r.finish(st, false)
		return nil, st.Err()
	}
	if !srv.start(r, md, lookupLatency(method, cc.routed)) {
		st := status.New(codes.Unavailable, "transport is closing")
		r.finish(st, false)
		return nil, st.Err()
	}
	return &clientStream{r: r}, nil
}

// addr is the net.Addr of a target.
func addr(target string) net.Addr {
	if host, port, err := net.SplitHostPort(target); err == nil {
		if ip := net.ParseIP(host); ip != nil {
			if p, err := net.LookupPort("tcp", port); err == nil {
				return &net.TCPAddr{IP: ip, Port: p}
			}
		}
	}
	return targetAddr(target)
}

type targetAddr string

func (a targetAddr) Network() string { return "tcp" }
func (a targetAddr) String() string  { return string(a) }
