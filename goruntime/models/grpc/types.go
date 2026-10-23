package grpc

import (
	"context"

	"leetbuild/goruntime/models/grpc/metadata"
)

// ServiceDesc describes a service: what generated code registers.
type ServiceDesc struct {
	ServiceName string
	// HandlerType is a pointer to the service's server interface (never inspected here: interpreted
	// interfaces cannot be checked from native code).
	HandlerType any
	Methods     []MethodDesc
	Streams     []StreamDesc
	Metadata    any
}

// MethodHandler is a unary method's generated handler.
type MethodHandler func(srv any, ctx context.Context, dec func(any) error, interceptor UnaryServerInterceptor) (any, error)

// MethodDesc describes a unary method.
type MethodDesc struct {
	MethodName string
	Handler    MethodHandler
}

// StreamHandler is a streaming method's generated handler (and a stream interceptor's next step).
type StreamHandler func(srv any, stream ServerStream) error

// StreamDesc describes a streaming method.
type StreamDesc struct {
	StreamName    string
	Handler       StreamHandler
	ServerStreams bool
	ClientStreams bool
}

// ServiceRegistrar registers services: *Server implements it.
type ServiceRegistrar interface {
	RegisterService(desc *ServiceDesc, impl any)
}

// ClientConnInterface is what generated clients call through: *ClientConn implements it.
type ClientConnInterface interface {
	Invoke(ctx context.Context, method string, args any, reply any, opts ...CallOption) error
	NewStream(ctx context.Context, desc *StreamDesc, method string, opts ...CallOption) (ClientStream, error)
}

// ServerStream is the server side of a streaming RPC.
type ServerStream interface {
	SetHeader(metadata.MD) error
	SendHeader(metadata.MD) error
	SetTrailer(metadata.MD)
	Context() context.Context
	SendMsg(m any) error
	RecvMsg(m any) error
}

// ClientStream is the client side of a streaming RPC.
type ClientStream interface {
	Header() (metadata.MD, error)
	Trailer() metadata.MD
	CloseSend() error
	Context() context.Context
	SendMsg(m any) error
	RecvMsg(m any) error
}

// UnaryServerInfo describes a unary call to an interceptor.
type UnaryServerInfo struct {
	Server     any
	FullMethod string
}

// UnaryHandler is the rest of a unary call, as a server interceptor sees it.
type UnaryHandler func(ctx context.Context, req any) (any, error)

// UnaryServerInterceptor intercepts unary calls on the server.
type UnaryServerInterceptor func(ctx context.Context, req any, info *UnaryServerInfo, handler UnaryHandler) (resp any, err error)

// StreamServerInfo describes a streaming call to an interceptor.
type StreamServerInfo struct {
	FullMethod     string
	IsClientStream bool
	IsServerStream bool
}

// StreamServerInterceptor intercepts streaming calls on the server.
type StreamServerInterceptor func(srv any, ss ServerStream, info *StreamServerInfo, handler StreamHandler) error

// UnaryInvoker is the rest of a unary call, as a client interceptor sees it.
type UnaryInvoker func(ctx context.Context, method string, req, reply any, cc *ClientConn, opts ...CallOption) error

// UnaryClientInterceptor intercepts unary calls on the client.
type UnaryClientInterceptor func(ctx context.Context, method string, req, reply any, cc *ClientConn, invoker UnaryInvoker, opts ...CallOption) error

// Streamer opens a stream, as a client stream interceptor sees it.
type Streamer func(ctx context.Context, desc *StreamDesc, cc *ClientConn, method string, opts ...CallOption) (ClientStream, error)

// StreamClientInterceptor intercepts stream creation on the client.
type StreamClientInterceptor func(ctx context.Context, desc *StreamDesc, cc *ClientConn, method string, streamer Streamer, opts ...CallOption) (ClientStream, error)

// MethodInfo describes one method of a registered service.
type MethodInfo struct {
	Name           string
	IsClientStream bool
	IsServerStream bool
}

// ServiceInfo describes a registered service.
type ServiceInfo struct {
	Methods  []MethodInfo
	Metadata any
}
