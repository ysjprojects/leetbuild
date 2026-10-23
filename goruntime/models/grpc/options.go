package grpc

import (
	"context"
	"net"
	"time"

	"leetbuild/goruntime/models/grpc/credentials"
	"leetbuild/goruntime/models/grpc/credentials/insecure"
	"leetbuild/goruntime/models/grpc/metadata"
	"leetbuild/goruntime/models/grpc/peer"
)

// ---- dial options --------------------------------------------------------------------------------

type dialOptions struct {
	creds        credentials.TransportCredentials
	perRPC       []credentials.PerRPCCredentials
	unary        []UnaryClientInterceptor
	stream       []StreamClientInterceptor
	callOptions  []CallOption
	authority    string
	userAgent    string
	contextDial  func(context.Context, string) (net.Conn, error)
	withBlock    bool
	dialDeadline time.Duration
}

// DialOption configures a ClientConn.
type DialOption interface{ applyDial(*dialOptions) }

type funcDialOption func(*dialOptions)

func (f funcDialOption) applyDial(o *dialOptions) { f(o) }

// EmptyDialOption does nothing.
type EmptyDialOption struct{}

func (EmptyDialOption) applyDial(*dialOptions) {}

// WithTransportCredentials sets the connection's security (insecure.NewCredentials() for none).
func WithTransportCredentials(creds credentials.TransportCredentials) DialOption {
	return funcDialOption(func(o *dialOptions) { o.creds = creds })
}

// WithInsecure disables transport security. Deprecated: use WithTransportCredentials(insecure.NewCredentials()).
func WithInsecure() DialOption {
	return funcDialOption(func(o *dialOptions) { o.creds = insecure.NewCredentials() })
}

// WithPerRPCCredentials adds metadata (a token) to every call.
func WithPerRPCCredentials(creds credentials.PerRPCCredentials) DialOption {
	return funcDialOption(func(o *dialOptions) { o.perRPC = append(o.perRPC, creds) })
}

// WithUnaryInterceptor sets the unary client interceptor.
func WithUnaryInterceptor(f UnaryClientInterceptor) DialOption {
	return funcDialOption(func(o *dialOptions) { o.unary = append([]UnaryClientInterceptor{f}, o.unary...) })
}

// WithChainUnaryInterceptor adds unary client interceptors, run first to last.
func WithChainUnaryInterceptor(fs ...UnaryClientInterceptor) DialOption {
	return funcDialOption(func(o *dialOptions) { o.unary = append(o.unary, fs...) })
}

// WithStreamInterceptor sets the stream client interceptor.
func WithStreamInterceptor(f StreamClientInterceptor) DialOption {
	return funcDialOption(func(o *dialOptions) { o.stream = append([]StreamClientInterceptor{f}, o.stream...) })
}

// WithChainStreamInterceptor adds stream client interceptors, run first to last.
func WithChainStreamInterceptor(fs ...StreamClientInterceptor) DialOption {
	return funcDialOption(func(o *dialOptions) { o.stream = append(o.stream, fs...) })
}

// WithDefaultCallOptions sets call options applied to every call.
func WithDefaultCallOptions(cos ...CallOption) DialOption {
	return funcDialOption(func(o *dialOptions) { o.callOptions = append(o.callOptions, cos...) })
}

// WithAuthority sets the :authority of every call.
func WithAuthority(a string) DialOption {
	return funcDialOption(func(o *dialOptions) { o.authority = a })
}

// WithUserAgent sets the user agent.
func WithUserAgent(s string) DialOption {
	return funcDialOption(func(o *dialOptions) { o.userAgent = s })
}

// WithContextDialer sets the function dialing the connection (unused: calls are in-process).
func WithContextDialer(f func(context.Context, string) (net.Conn, error)) DialOption {
	return funcDialOption(func(o *dialOptions) { o.contextDial = f })
}

// WithBlock makes Dial wait for the connection (it is always ready in-process).
func WithBlock() DialOption { return funcDialOption(func(o *dialOptions) { o.withBlock = true }) }

// WithReturnConnectionError is WithBlock reporting the last connection error.
func WithReturnConnectionError() DialOption { return WithBlock() }

// WithTimeout bounds a blocking Dial.
func WithTimeout(d time.Duration) DialOption {
	return funcDialOption(func(o *dialOptions) { o.dialDeadline = d })
}

// WithDefaultServiceConfig sets the service config JSON (not interpreted: no retry policy, no LB).
func WithDefaultServiceConfig(s string) DialOption { return EmptyDialOption{} }

// WithDisableServiceConfig ignores service configs from the resolver.
func WithDisableServiceConfig() DialOption { return EmptyDialOption{} }

// WithDisableRetry disables transparent retries.
func WithDisableRetry() DialOption { return EmptyDialOption{} }

// WithNoProxy disables proxies.
func WithNoProxy() DialOption { return EmptyDialOption{} }

// WithIdleTimeout sets the idle timeout (connections never idle in-process).
func WithIdleTimeout(d time.Duration) DialOption { return EmptyDialOption{} }

// WithMaxMsgSize sets the largest message the client receives (not enforced).
func WithMaxMsgSize(s int) DialOption { return EmptyDialOption{} }

// WithReadBufferSize sets the read buffer size (no buffers in-process).
func WithReadBufferSize(s int) DialOption { return EmptyDialOption{} }

// WithWriteBufferSize sets the write buffer size (no buffers in-process).
func WithWriteBufferSize(s int) DialOption { return EmptyDialOption{} }

// ---- call options --------------------------------------------------------------------------------

type callInfo struct {
	header   []*metadata.MD
	trailer  []*metadata.MD
	peer     []*peer.Peer
	onFinish []func(error)
}

// CallOption configures one call.
type CallOption interface{ applyCall(*callInfo) }

// EmptyCallOption does nothing.
type EmptyCallOption struct{}

func (EmptyCallOption) applyCall(*callInfo) {}

// HeaderCallOption receives the header metadata.
type HeaderCallOption struct{ HeaderAddr *metadata.MD }

func (o HeaderCallOption) applyCall(c *callInfo) { c.header = append(c.header, o.HeaderAddr) }

// Header stores the call's header metadata in *md once the call completes.
func Header(md *metadata.MD) CallOption { return HeaderCallOption{HeaderAddr: md} }

// TrailerCallOption receives the trailer metadata.
type TrailerCallOption struct{ TrailerAddr *metadata.MD }

func (o TrailerCallOption) applyCall(c *callInfo) { c.trailer = append(c.trailer, o.TrailerAddr) }

// Trailer stores the call's trailer metadata in *md once the call completes.
func Trailer(md *metadata.MD) CallOption { return TrailerCallOption{TrailerAddr: md} }

// PeerCallOption receives the server's address.
type PeerCallOption struct{ PeerAddr *peer.Peer }

func (o PeerCallOption) applyCall(c *callInfo) { c.peer = append(c.peer, o.PeerAddr) }

// Peer stores the server's address in *p once the call completes.
func Peer(p *peer.Peer) CallOption { return PeerCallOption{PeerAddr: p} }

// OnFinishCallOption runs a function when the call ends.
type OnFinishCallOption struct{ OnFinish func(error) }

func (o OnFinishCallOption) applyCall(c *callInfo) { c.onFinish = append(c.onFinish, o.OnFinish) }

// OnFinish runs f with the call's error (nil on success) when the call ends.
func OnFinish(f func(err error)) CallOption { return OnFinishCallOption{OnFinish: f} }

// FailFastCallOption is WaitForReady's negation.
type FailFastCallOption struct{ FailFast bool }

func (FailFastCallOption) applyCall(*callInfo) {}

// WaitForReady: a call to a server that is not up waits for it instead of failing UNAVAILABLE
// (not modelled: in-process servers are up or absent, so calls fail fast).
func WaitForReady(waitForReady bool) CallOption { return FailFastCallOption{FailFast: !waitForReady} }

// MaxRecvMsgSizeCallOption bounds the response size (not enforced).
type MaxRecvMsgSizeCallOption struct{ MaxRecvMsgSize int }

func (MaxRecvMsgSizeCallOption) applyCall(*callInfo) {}

// MaxCallRecvMsgSize bounds the response size (not enforced).
func MaxCallRecvMsgSize(bytes int) CallOption { return MaxRecvMsgSizeCallOption{MaxRecvMsgSize: bytes} }

// MaxSendMsgSizeCallOption bounds the request size (not enforced).
type MaxSendMsgSizeCallOption struct{ MaxSendMsgSize int }

func (MaxSendMsgSizeCallOption) applyCall(*callInfo) {}

// MaxCallSendMsgSize bounds the request size (not enforced).
func MaxCallSendMsgSize(bytes int) CallOption { return MaxSendMsgSizeCallOption{MaxSendMsgSize: bytes} }

// CompressorCallOption names the compressor (no compression in-process).
type CompressorCallOption struct{ CompressorType string }

func (CompressorCallOption) applyCall(*callInfo) {}

// UseCompressor names the compressor (no compression in-process).
func UseCompressor(name string) CallOption { return CompressorCallOption{CompressorType: name} }

// ---- server options ------------------------------------------------------------------------------

type serverOptions struct {
	creds          credentials.TransportCredentials
	unary          []UnaryServerInterceptor
	stream         []StreamServerInterceptor
	unknownService StreamHandler
}

// ServerOption configures a Server.
type ServerOption interface{ applyServer(*serverOptions) }

type funcServerOption func(*serverOptions)

func (f funcServerOption) applyServer(o *serverOptions) { f(o) }

// EmptyServerOption does nothing.
type EmptyServerOption struct{}

func (EmptyServerOption) applyServer(*serverOptions) {}

// Creds sets the server's transport credentials.
func Creds(c credentials.TransportCredentials) ServerOption {
	return funcServerOption(func(o *serverOptions) { o.creds = c })
}

// UnaryInterceptor sets the unary server interceptor.
func UnaryInterceptor(i UnaryServerInterceptor) ServerOption {
	return funcServerOption(func(o *serverOptions) { o.unary = append([]UnaryServerInterceptor{i}, o.unary...) })
}

// ChainUnaryInterceptor adds unary server interceptors, run first to last.
func ChainUnaryInterceptor(is ...UnaryServerInterceptor) ServerOption {
	return funcServerOption(func(o *serverOptions) { o.unary = append(o.unary, is...) })
}

// StreamInterceptor sets the stream server interceptor.
func StreamInterceptor(i StreamServerInterceptor) ServerOption {
	return funcServerOption(func(o *serverOptions) { o.stream = append([]StreamServerInterceptor{i}, o.stream...) })
}

// ChainStreamInterceptor adds stream server interceptors, run first to last.
func ChainStreamInterceptor(is ...StreamServerInterceptor) ServerOption {
	return funcServerOption(func(o *serverOptions) { o.stream = append(o.stream, is...) })
}

// UnknownServiceHandler handles calls to services nobody registered.
func UnknownServiceHandler(h StreamHandler) ServerOption {
	return funcServerOption(func(o *serverOptions) { o.unknownService = h })
}

// MaxRecvMsgSize bounds request size (not enforced).
func MaxRecvMsgSize(m int) ServerOption { return EmptyServerOption{} }

// MaxSendMsgSize bounds response size (not enforced).
func MaxSendMsgSize(m int) ServerOption { return EmptyServerOption{} }

// MaxConcurrentStreams bounds concurrent streams per connection (not enforced).
func MaxConcurrentStreams(n uint32) ServerOption { return EmptyServerOption{} }

// ConnectionTimeout bounds connection setup (connections are in-process).
func ConnectionTimeout(d time.Duration) ServerOption { return EmptyServerOption{} }

// NumStreamWorkers sets the stream worker pool size (handlers always run on their own goroutine).
func NumStreamWorkers(n uint32) ServerOption { return EmptyServerOption{} }

// ---- interceptor chains --------------------------------------------------------------------------

func chainUnaryServer(is []UnaryServerInterceptor) UnaryServerInterceptor {
	switch len(is) {
	case 0:
		return nil
	case 1:
		return is[0]
	}
	return func(ctx context.Context, req any, info *UnaryServerInfo, handler UnaryHandler) (any, error) {
		return is[0](ctx, req, info, unaryServerStep(is, 0, info, handler))
	}
}

func unaryServerStep(is []UnaryServerInterceptor, i int, info *UnaryServerInfo, final UnaryHandler) UnaryHandler {
	if i == len(is)-1 {
		return final
	}
	return func(ctx context.Context, req any) (any, error) {
		return is[i+1](ctx, req, info, unaryServerStep(is, i+1, info, final))
	}
}

func chainStreamServer(is []StreamServerInterceptor) StreamServerInterceptor {
	switch len(is) {
	case 0:
		return nil
	case 1:
		return is[0]
	}
	return func(srv any, ss ServerStream, info *StreamServerInfo, handler StreamHandler) error {
		return is[0](srv, ss, info, streamServerStep(is, 0, info, handler))
	}
}

func streamServerStep(is []StreamServerInterceptor, i int, info *StreamServerInfo, final StreamHandler) StreamHandler {
	if i == len(is)-1 {
		return final
	}
	return func(srv any, ss ServerStream) error {
		return is[i+1](srv, ss, info, streamServerStep(is, i+1, info, final))
	}
}

func chainUnaryClient(is []UnaryClientInterceptor, final UnaryInvoker) UnaryInvoker {
	for i := len(is) - 1; i >= 0; i-- {
		next, ic := final, is[i]
		final = func(ctx context.Context, method string, req, reply any, cc *ClientConn, opts ...CallOption) error {
			return ic(ctx, method, req, reply, cc, next, opts...)
		}
	}
	return final
}

func chainStreamClient(is []StreamClientInterceptor, final Streamer) Streamer {
	for i := len(is) - 1; i >= 0; i-- {
		next, ic := final, is[i]
		final = func(ctx context.Context, desc *StreamDesc, cc *ClientConn, method string, opts ...CallOption) (ClientStream, error) {
			return ic(ctx, desc, cc, method, next, opts...)
		}
	}
	return final
}
