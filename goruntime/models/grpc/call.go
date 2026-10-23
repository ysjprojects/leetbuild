package grpc

import (
	"context"
	"io"
	"sync"
	"time"

	"leetbuild/goruntime/models/grpc/codes"
	"leetbuild/goruntime/models/grpc/metadata"
	"leetbuild/goruntime/models/grpc/peer"
	"leetbuild/goruntime/models/grpc/status"
	"leetbuild/goruntime/models/internal/pbreflect"
	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
)

// rpc is one call in flight: both ends of the stream (a unary call is a stream of one request and
// one response), the server's context, and the outcome. Every state change broadcasts on changed,
// so each side blocks on a channel until there is something for it — never polls.
type rpc struct {
	method        string
	clientStreams bool
	serverStreams bool
	record        *Call
	info          callInfo
	clientCtx     context.Context
	target        string

	sctx         context.Context
	cancelServer context.CancelFunc
	stopWatch    func() bool
	server       *Server

	mu         sync.Mutex
	changed    chan struct{}
	toServer   []any // message snapshots (deep copies taken when sent)
	closeSend  bool
	toClient   []any
	header     metadata.MD
	headerSent bool // the server sent its headers (SendHeader, a first message, or the end)
	trailer    metadata.MD
	done       bool
	aborted    bool // ended from the client's side (its context, a stopped server): no more messages
	st         *status.Status
	received   bool // a non-streaming response was handed to the client
}

func newRPC(ctx context.Context, method, target string, desc *StreamDesc, rec *Call, info callInfo) *rpc {
	return &rpc{
		method:        method,
		clientStreams: desc.ClientStreams,
		serverStreams: desc.ServerStreams,
		record:        rec,
		info:          info,
		clientCtx:     ctx,
		target:        target,
		changed:       make(chan struct{}),
	}
}

// broadcast wakes every waiter; call with mu held.
func (r *rpc) broadcast() {
	close(r.changed)
	r.changed = make(chan struct{})
}

// wait blocks until cond (evaluated with mu held) holds or ctx ends; it reports whether cond held.
func (r *rpc) wait(ctx context.Context, cond func() bool) bool {
	for {
		r.mu.Lock()
		if cond() {
			r.mu.Unlock()
			return true
		}
		ch := r.changed
		r.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			r.mu.Lock()
			ok := cond()
			r.mu.Unlock()
			return ok
		}
	}
}

// finish ends the call with st (once). aborted: ended from the client's side.
func (r *rpc) finish(st *status.Status, aborted bool) {
	r.mu.Lock()
	if r.done {
		r.mu.Unlock()
		return
	}
	r.done, r.aborted, r.st = true, aborted, st
	r.headerSent = true
	update(r.record, func(c *Call) {
		c.Done, c.Code, c.Message = true, st.Code(), st.Message()
	})
	// The call options are filled before anyone waiting on the call wakes.
	for _, h := range r.info.header {
		*h = r.header.Copy()
	}
	for _, t := range r.info.trailer {
		*t = r.trailer.Copy()
	}
	for _, p := range r.info.peer {
		*p = peer.Peer{Addr: addr(r.target)}
	}
	r.broadcast()
	r.mu.Unlock()
	if r.cancelServer != nil {
		r.cancelServer()
	}
	if r.stopWatch != nil {
		r.stopWatch()
	}
	if r.server != nil {
		r.server.untrack(r)
	}
	for _, f := range r.info.onFinish {
		func() {
			defer world.Recover()
			f(st.Err())
		}()
	}
}

// statusOf is the status a handler's error becomes: status errors keep theirs, context errors
// become Canceled / DeadlineExceeded, anything else Unknown with the error's text.
func statusOf(err error) *status.Status {
	if err == nil {
		return status.New(codes.OK, "")
	}
	if s, ok := status.FromError(err); ok {
		return s
	}
	return status.FromContextError(err)
}

func snapshot(m any) any { return pbreflect.DeepCopy(pbreflect.Of(m)).Interface() }

// ---- the server side -----------------------------------------------------------------------------

type streamKey struct{}

// serverStream is the handler's end.
type serverStream struct{ r *rpc }

func (s *serverStream) Context() context.Context { return s.r.sctx }

func (s *serverStream) SetHeader(md metadata.MD) error {
	r := s.r
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.headerSent {
		return status.Error(codes.Internal, "transport: SetHeader called after the header was sent")
	}
	r.header = metadata.Join(r.header, md)
	return nil
}

func (s *serverStream) SendHeader(md metadata.MD) error {
	r := s.r
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.headerSent {
		return status.Error(codes.Internal, "transport: SendHeader called multiple times")
	}
	r.header = metadata.Join(r.header, md)
	r.headerSent = true
	r.broadcast()
	return nil
}

func (s *serverStream) SetTrailer(md metadata.MD) {
	r := s.r
	r.mu.Lock()
	defer r.mu.Unlock()
	r.trailer = metadata.Join(r.trailer, md)
}

func (s *serverStream) SendMsg(m any) error {
	r := s.r
	if err := r.sctx.Err(); err != nil {
		return status.FromContextError(err).Err()
	}
	msg := snapshot(m)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done {
		if r.st.Code() != codes.OK {
			return r.st.Err()
		}
		return status.Error(codes.Internal, "transport: the stream is done")
	}
	r.headerSent = true
	r.toClient = append(r.toClient, msg)
	r.broadcast()
	return nil
}

func (s *serverStream) RecvMsg(m any) error {
	r := s.r
	ok := r.wait(r.sctx, func() bool { return len(r.toServer) > 0 || r.closeSend || r.done })
	r.mu.Lock()
	if len(r.toServer) > 0 && !r.aborted {
		msg := r.toServer[0]
		r.toServer = r.toServer[1:]
		r.mu.Unlock()
		return pbreflect.Transfer(m, msg)
	}
	done, st, closed := r.done, r.st, r.closeSend
	r.mu.Unlock()
	switch {
	case done && st.Code() != codes.OK:
		return st.Err()
	case closed || done:
		return io.EOF
	case !ok:
		return status.FromContextError(r.sctx.Err()).Err()
	}
	return io.EOF
}

// serve runs the handler on its own goroutine once the latency elapsed; a panic in it ends the
// call UNKNOWN and is reported to the check.
func (r *rpc) serve(s *Server, latency time.Duration) {
	go func() {
		if latency > 0 {
			t := vclock.NewTimer(latency)
			select {
			case <-t.C:
			case <-r.sctx.Done():
				t.Stop()
				r.finish(status.FromContextError(r.sctx.Err()), false)
				return
			}
		}
		r.run(s)
	}()
}

func (r *rpc) run(s *Server) {
	defer func() {
		if p := recover(); p != nil {
			r.finish(status.Newf(codes.Unknown, "grpc: the handler of %s panicked: %v", r.method, p), false)
			if world.PanicHandler != nil {
				world.PanicHandler(p)
			}
		}
	}()
	impl, md, sd := s.lookup(r.method)
	ss := &serverStream{r: r}
	var err error
	switch {
	case md != nil:
		dec := func(m any) error {
			if err := ss.RecvMsg(m); err != nil {
				if err == io.EOF {
					return status.Error(codes.Internal, "grpc: the client sent no request message")
				}
				return err
			}
			return nil
		}
		var resp any
		resp, err = md.Handler(impl, r.sctx, dec, s.unary)
		if err == nil {
			if resp == nil {
				err = status.Error(codes.Internal, "grpc: error while marshaling: proto: Marshal called with nil")
			} else {
				err = ss.SendMsg(resp)
			}
		}
	case sd != nil:
		info := &StreamServerInfo{FullMethod: r.method, IsClientStream: sd.ClientStreams, IsServerStream: sd.ServerStreams}
		if s.stream != nil {
			err = s.stream(impl, ss, info, sd.Handler)
		} else {
			err = sd.Handler(impl, ss)
		}
	case s.opts.unknownService != nil:
		if s.stream != nil {
			err = s.stream(nil, ss, &StreamServerInfo{FullMethod: r.method, IsClientStream: true, IsServerStream: true}, s.opts.unknownService)
		} else {
			err = s.opts.unknownService(nil, ss)
		}
	default:
		service, method := splitMethod(r.method)
		if s.hasService(service) {
			err = status.Errorf(codes.Unimplemented, "unknown method %s for service %s", method, service)
		} else {
			err = status.Errorf(codes.Unimplemented, "unknown service %s", service)
		}
	}
	r.finish(statusOf(err), false)
}

// ---- the client side -----------------------------------------------------------------------------

// clientStream is the caller's end.
type clientStream struct{ r *rpc }

func (c *clientStream) Context() context.Context { return c.r.clientCtx }

func (c *clientStream) SendMsg(m any) error {
	r := c.r
	r.mu.Lock()
	if r.closeSend {
		r.mu.Unlock()
		return status.Error(codes.Internal, "SendMsg called after CloseSend")
	}
	if r.done {
		r.mu.Unlock()
		if r.record.Request == nil { // a call failed before reaching a server still logs its request
			msg := snapshot(m)
			update(r.record, func(call *Call) { call.Request = msg })
		}
		if !r.clientStreams {
			return nil // the request of a call that already ended: dropped, its status comes with RecvMsg
		}
		return io.EOF
	}
	r.mu.Unlock()
	msg := snapshot(m)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.toServer = append(r.toServer, msg)
	r.broadcast()
	if r.record.Request == nil {
		update(r.record, func(call *Call) { call.Request = msg })
	}
	return nil
}

func (c *clientStream) CloseSend() error {
	r := c.r
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closeSend {
		r.closeSend = true
		r.broadcast()
	}
	return nil
}

func (c *clientStream) RecvMsg(m any) error {
	r := c.r
	if !r.serverStreams {
		// One response: it counts once the call ended, with its status.
		if !r.wait(r.clientCtx, func() bool { return r.done }) {
			r.finish(status.FromContextError(r.clientCtx.Err()), true)
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		switch {
		case r.st.Code() != codes.OK:
			return r.st.Err()
		case r.received:
			return io.EOF
		case len(r.toClient) == 0:
			return status.Error(codes.Internal, "cardinality violation: received no response message from non-server-streaming RPC")
		}
		r.received = true
		return pbreflect.Transfer(m, r.toClient[0])
	}
	ok := r.wait(r.clientCtx, func() bool { return len(r.toClient) > 0 || r.done })
	r.mu.Lock()
	if len(r.toClient) > 0 && !r.aborted {
		msg := r.toClient[0]
		r.toClient = r.toClient[1:]
		r.mu.Unlock()
		return pbreflect.Transfer(m, msg)
	}
	done, st := r.done, r.st
	r.mu.Unlock()
	if !done && !ok {
		st := status.FromContextError(r.clientCtx.Err())
		r.finish(st, true)
		return st.Err()
	}
	if st.Code() == codes.OK {
		return io.EOF
	}
	return st.Err()
}

func (c *clientStream) Header() (metadata.MD, error) {
	r := c.r
	r.wait(r.clientCtx, func() bool { return r.headerSent || r.done })
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.headerSent && !r.done {
		return nil, status.FromContextError(r.clientCtx.Err()).Err()
	}
	if r.done && r.header == nil && r.st.Code() != codes.OK {
		return nil, r.st.Err()
	}
	return r.header.Copy(), nil
}

func (c *clientStream) Trailer() metadata.MD {
	r := c.r
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.trailer.Copy()
}

func splitMethod(path string) (service, method string) {
	for i := len(path) - 1; i > 0; i-- {
		if path[i] == '/' {
			return path[1:i], path[i+1:]
		}
	}
	return "", path
}

func failureDetails(f failure) string {
	if f.details != "" {
		return f.details
	}
	return lowerName(f.code)
}

// lowerName is the code's name in snake case, as the TypeScript and Python runtimes default an
// injected failure's details: "unavailable", "deadline_exceeded".
func lowerName(c codes.Code) string {
	name := c.String()
	out := make([]byte, 0, len(name)+4)
	for i := range len(name) {
		ch := name[i]
		if 'A' <= ch && ch <= 'Z' {
			if i > 0 {
				out = append(out, '_')
			}
			ch += 'a' - 'A'
		}
		out = append(out, ch)
	}
	return string(out)
}
