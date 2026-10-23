package grpc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"leetbuild/goruntime/models/grpc/codes"
	"leetbuild/goruntime/models/grpc/credentials/insecure"
	"leetbuild/goruntime/models/grpc/metadata"
	"leetbuild/goruntime/models/grpc/status"
	"leetbuild/goruntime/models/netx"
	"leetbuild/goruntime/vclock"
)

type echoReq struct {
	Text  string   `protobuf:"bytes,1,opt,name=text,proto3" json:"text,omitempty"`
	Count int32    `protobuf:"varint,2,opt,name=count,proto3" json:"count,omitempty"`
	Tags  []string `protobuf:"bytes,3,rep,name=tags,proto3" json:"tags,omitempty"`
}

type echoReply struct {
	Text string `protobuf:"bytes,1,opt,name=text,proto3" json:"text,omitempty"`
	Seq  int32  `protobuf:"varint,2,opt,name=seq,proto3" json:"seq,omitempty"`
}

// echo is a native service: Say (unary), Count (server streaming), Sum (client streaming), Chat (bidi).
type echo struct {
	mu      sync.Mutex
	seen    []string
	block   chan struct{} // Say waits on it (or on ctx) when set
	ctxErr  error
	header  metadata.MD
	trailer metadata.MD
}

func (e *echo) Say(ctx context.Context, in *echoReq) (*echoReply, error) {
	e.mu.Lock()
	e.seen = append(e.seen, in.Text)
	block := e.block
	e.mu.Unlock()
	if e.header != nil {
		_ = SetHeader(ctx, e.header)
	}
	if e.trailer != nil {
		_ = SetTrailer(ctx, e.trailer)
	}
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			e.mu.Lock()
			e.ctxErr = ctx.Err()
			e.mu.Unlock()
			return nil, ctx.Err()
		}
	}
	switch in.Text {
	case "boom":
		return nil, errors.New("plain failure")
	case "missing":
		return nil, status.Error(codes.NotFound, "no such thing")
	case "panic":
		panic("handler exploded")
	}
	md, _ := metadata.FromIncomingContext(ctx)
	in.Text = "mutated by the server" // must not reach the client's request
	return &echoReply{Text: "echo " + fmt.Sprint(md.Get("x-id")), Seq: in.Count}, nil
}

var echoDesc = ServiceDesc{
	ServiceName: "test.Echo",
	Methods: []MethodDesc{{MethodName: "Say", Handler: func(srv any, ctx context.Context, dec func(any) error, interceptor UnaryServerInterceptor) (any, error) {
		in := new(echoReq)
		if err := dec(in); err != nil {
			return nil, err
		}
		if interceptor == nil {
			return srv.(*echo).Say(ctx, in)
		}
		return interceptor(ctx, in, &UnaryServerInfo{Server: srv, FullMethod: "/test.Echo/Say"}, func(ctx context.Context, req any) (any, error) {
			return srv.(*echo).Say(ctx, req.(*echoReq))
		})
	}}},
	Streams: []StreamDesc{
		{StreamName: "Count", ServerStreams: true, Handler: func(srv any, ss ServerStream) error {
			in := new(echoReq)
			if err := ss.RecvMsg(in); err != nil {
				return err
			}
			for i := range in.Count {
				if err := ss.SendMsg(&echoReply{Text: in.Text, Seq: i}); err != nil {
					return err
				}
			}
			if in.Text == "fail" {
				return status.Error(codes.ResourceExhausted, "too slow")
			}
			if in.Text == "wait" {
				<-ss.Context().Done()
				return ss.Context().Err()
			}
			return nil
		}},
		{StreamName: "Sum", ClientStreams: true, Handler: func(srv any, ss ServerStream) error {
			var total int32
			for {
				in := new(echoReq)
				err := ss.RecvMsg(in)
				if err == io.EOF {
					return ss.SendMsg(&echoReply{Text: "sum", Seq: total})
				}
				if err != nil {
					return err
				}
				total += in.Count
			}
		}},
		{StreamName: "Chat", ClientStreams: true, ServerStreams: true, Handler: func(srv any, ss ServerStream) error {
			for {
				in := new(echoReq)
				err := ss.RecvMsg(in)
				if err == io.EOF {
					return nil
				}
				if err != nil {
					return err
				}
				if err := ss.SendMsg(&echoReply{Text: "re: " + in.Text}); err != nil {
					return err
				}
			}
		}},
	},
}

func setup(t *testing.T) *vclock.Fake {
	t.Helper()
	Reset()
	clock := vclock.NewFake()
	vclock.Set(clock)
	t.Cleanup(func() {
		Reset()
		vclock.Set(vclock.Real{})
	})
	return clock
}

func dial(t *testing.T, target string) *ClientConn {
	t.Helper()
	cc, err := NewClient(target, WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	return cc
}

// advance waits (in real time) until the clock has n pending timers, then moves it by d.
func advance(t *testing.T, clock *vclock.Fake, n int, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for clock.Pending() < n {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d pending timers (have %d)", n, clock.Pending())
		}
		time.Sleep(time.Millisecond)
	}
	clock.Advance(d)
}

func await[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(2 * time.Second):
		t.Fatal("timed out")
	}
	var zero T
	return zero
}

func TestNewClientNeedsCredentials(t *testing.T) {
	setup(t)
	if _, err := NewClient("x:1"); err == nil {
		t.Fatal("NewClient without transport credentials must fail")
	}
}

func TestUnaryRoundTripMetadataAndCopies(t *testing.T) {
	setup(t)
	impl := &echo{header: metadata.Pairs("h", "1"), trailer: metadata.Pairs("t", "2")}
	PeerServer("echo:1").RegisterService(&echoDesc, impl)
	cc := dial(t, "dns:///echo:1")
	req := &echoReq{Text: "hi", Count: 7, Tags: []string{"a"}}
	ctx := metadata.AppendToOutgoingContext(context.Background(), "X-Id", "42")
	var header, trailer metadata.MD
	reply := new(echoReply)
	if err := cc.Invoke(ctx, "/test.Echo/Say", req, reply, Header(&header), Trailer(&trailer)); err != nil {
		t.Fatal(err)
	}
	if reply.Text != "echo [42]" || reply.Seq != 7 {
		t.Fatalf("reply %+v", reply)
	}
	if req.Text != "hi" {
		t.Fatalf("the server's mutation reached the client's request: %q", req.Text)
	}
	if header.Get("h")[0] != "1" || trailer.Get("t")[0] != "2" {
		t.Fatalf("header %v trailer %v", header, trailer)
	}
	calls := CallsTo("Say", "echo:1")
	if len(calls) != 1 || !calls[0].Done || calls[0].Code != codes.OK || calls[0].Metadata.Get("x-id")[0] != "42" {
		t.Fatalf("calls %+v", calls)
	}
	if got := calls[0].Request.(*echoReq); got.Text != "hi" || got == req {
		t.Fatalf("the call log must hold a copy of the request, got %+v", got)
	}
	if LearnerCalls() != 1 {
		t.Fatalf("LearnerCalls = %d", LearnerCalls())
	}
}

func TestErrorsBecomeStatuses(t *testing.T) {
	setup(t)
	PeerServer("").RegisterService(&echoDesc, &echo{})
	cc := dial(t, "anything:9")
	for text, want := range map[string]codes.Code{"boom": codes.Unknown, "missing": codes.NotFound, "panic": codes.Unknown} {
		err := cc.Invoke(context.Background(), "/test.Echo/Say", &echoReq{Text: text}, new(echoReply))
		if status.Code(err) != want {
			t.Errorf("%s: got %v, want %v", text, err, want)
		}
	}
	if err := cc.Invoke(context.Background(), "/test.Echo/Nope", &echoReq{}, new(echoReply)); status.Code(err) != codes.Unimplemented {
		t.Errorf("unknown method: %v", err)
	}
	if err := cc.Invoke(context.Background(), "/test.Other/Say", &echoReq{}, new(echoReply)); status.Code(err) != codes.Unimplemented {
		t.Errorf("unknown service: %v", err)
	}
	Reset()
	if err := cc.Invoke(context.Background(), "/test.Echo/Say", &echoReq{}, new(echoReply)); status.Code(err) != codes.Unavailable {
		t.Errorf("no server: %v", err)
	}
	if CallsTo("/test.Echo/Say", "")[0].Code != codes.Unavailable {
		t.Errorf("the failed call must be logged UNAVAILABLE")
	}
}

func TestFailuresAreInjectedBeforeTheHandler(t *testing.T) {
	setup(t)
	impl := &echo{}
	PeerServer("echo:1").RegisterService(&echoDesc, impl)
	FailNext("Say", codes.Unavailable, "", 2, "")
	FailNext("/test.Echo/Say", codes.ResourceExhausted, "quota", 1, "other:1")
	cc := dial(t, "echo:1")
	for range 2 {
		err := cc.Invoke(context.Background(), "/test.Echo/Say", &echoReq{Text: "x"}, new(echoReply))
		if s := status.Convert(err); s.Code() != codes.Unavailable || s.Message() != "unavailable" {
			t.Fatalf("got %v", err)
		}
	}
	if err := cc.Invoke(context.Background(), "/test.Echo/Say", &echoReq{Text: "x"}, new(echoReply)); err != nil {
		t.Fatalf("the third call must succeed: %v", err)
	}
	if len(impl.seen) != 1 {
		t.Fatalf("failed calls reached the handler: %v", impl.seen)
	}
	if n := len(CallsTo("Say", "")); n != 3 {
		t.Fatalf("logged %d calls, want 3", n)
	}
	for _, c := range CallsTo("Say", "") {
		if req, ok := c.Request.(*echoReq); !ok || req.Text != "x" {
			t.Fatalf("an injected failure must log the request too: %+v", c)
		}
	}
	Reset()
	_ = dial(t, "nobody:1").Invoke(context.Background(), "/test.Echo/Say", &echoReq{Text: "lost"}, new(echoReply))
	if c := CallsTo("Say", "")[0]; c.Code != codes.Unavailable || c.Request.(*echoReq).Text != "lost" {
		t.Fatalf("a call nothing serves must log its request: %+v", c)
	}
}

func TestLatencyAndDeadlinesOnTheVirtualClock(t *testing.T) {
	clock := setup(t)
	impl := &echo{}
	PeerServer("echo:1").RegisterService(&echoDesc, impl)
	SetLatency("Say", 3*time.Second, "")
	cc := dial(t, "echo:1")

	// A deadline shorter than the latency: DEADLINE_EXCEEDED, the handler never runs.
	done := make(chan error, 1)
	go func() {
		ctx, cancel := vclock.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		done <- cc.Invoke(ctx, "/test.Echo/Say", &echoReq{Text: "late"}, new(echoReply))
	}()
	advance(t, clock, 2, 500*time.Millisecond)
	if err := await(t, done); status.Code(err) != codes.DeadlineExceeded {
		t.Fatalf("got %v", err)
	}
	call := CallsTo("Say", "")[0]
	if !call.HasDeadline() || call.Timeout != 500*time.Millisecond || call.Code != codes.DeadlineExceeded {
		t.Fatalf("call %+v", call)
	}
	clock.Advance(5 * time.Second)
	if len(impl.seen) != 0 {
		t.Fatalf("the handler ran: %v", impl.seen)
	}

	// Without a deadline the call takes the latency.
	start := vclock.Now()
	go func() {
		done <- cc.Invoke(context.Background(), "/test.Echo/Say", &echoReq{Text: "slow"}, new(echoReply))
	}()
	advance(t, clock, 1, 3*time.Second)
	if err := await(t, done); err != nil {
		t.Fatal(err)
	}
	if vclock.Since(start) != 3*time.Second {
		t.Fatalf("took %v", vclock.Since(start))
	}
}

func TestDeadlineAndCancellationReachTheHandler(t *testing.T) {
	clock := setup(t)
	impl := &echo{block: make(chan struct{})}
	PeerServer("echo:1").RegisterService(&echoDesc, impl)
	cc := dial(t, "echo:1")

	done := make(chan error, 1)
	go func() {
		ctx, cancel := vclock.WithTimeout(context.Background(), time.Second)
		defer cancel()
		done <- cc.Invoke(ctx, "/test.Echo/Say", &echoReq{Text: "a"}, new(echoReply))
	}()
	advance(t, clock, 2, time.Second) // the client's and the server's deadline timers
	if err := await(t, done); status.Code(err) != codes.DeadlineExceeded {
		t.Fatalf("got %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() { done <- cc.Invoke(ctx, "/test.Echo/Say", &echoReq{Text: "b"}, new(echoReply)) }()
	for len(CallsTo("Say", "")) < 2 {
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := await(t, done); status.Code(err) != codes.Canceled {
		t.Fatalf("got %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		impl.mu.Lock()
		err := impl.ctxErr
		impl.mu.Unlock()
		if errors.Is(err, context.Canceled) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the handler's context was not cancelled: %v", err)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestInterceptors(t *testing.T) {
	setup(t)
	var order []string
	var mu sync.Mutex
	note := func(s string) {
		mu.Lock()
		order = append(order, s)
		mu.Unlock()
	}
	srv := NewServer(ChainUnaryInterceptor(
		func(ctx context.Context, req any, info *UnaryServerInfo, h UnaryHandler) (any, error) {
			note("server1 " + info.FullMethod)
			return h(ctx, req)
		},
		func(ctx context.Context, req any, info *UnaryServerInfo, h UnaryHandler) (any, error) {
			note("server2")
			if md, _ := metadata.FromIncomingContext(ctx); len(md.Get("authorization")) == 0 {
				return nil, status.Error(codes.Unauthenticated, "no token")
			}
			return h(ctx, req)
		},
	))
	srv.RegisterService(&echoDesc, &echo{})
	lis, err := netx.Listen("tcp", ":7000")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(lis) }()
	for !Serving("/test.Echo/Say", "localhost:7000") {
		time.Sleep(time.Millisecond)
	}
	cc, _ := NewClient("localhost:7000", WithTransportCredentials(insecure.NewCredentials()),
		WithUnaryInterceptor(func(ctx context.Context, method string, req, reply any, cc *ClientConn, invoker UnaryInvoker, opts ...CallOption) error {
			note("client " + method)
			return invoker(metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer x"), method, req, reply, cc, opts...)
		}))
	if err := cc.Invoke(context.Background(), "/test.Echo/Say", &echoReq{Text: "x"}, new(echoReply)); err != nil {
		t.Fatal(err)
	}
	want := []string{"client /test.Echo/Say", "server1 /test.Echo/Say", "server2"}
	if fmt.Sprint(order) != fmt.Sprint(want) {
		t.Fatalf("order %v", order)
	}
	plain := dial(t, "0.0.0.0:7000")
	if err := plain.Invoke(context.Background(), "/test.Echo/Say", &echoReq{}, new(echoReply)); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("got %v", err)
	}
	srv.GracefulStop()
	if err := plain.Invoke(context.Background(), "/test.Echo/Say", &echoReq{}, new(echoReply)); status.Code(err) != codes.Unavailable {
		t.Fatalf("after GracefulStop: %v", err)
	}
}

func TestServerStreaming(t *testing.T) {
	setup(t)
	PeerServer("").RegisterService(&echoDesc, &echo{})
	cc := dial(t, "e:1")
	desc := &echoDesc.Streams[0]
	stream, err := cc.NewStream(context.Background(), desc, "/test.Echo/Count")
	if err != nil {
		t.Fatal(err)
	}
	_ = stream.SendMsg(&echoReq{Text: "n", Count: 3})
	_ = stream.CloseSend()
	var got []int32
	for {
		m := new(echoReply)
		err := stream.RecvMsg(m)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, m.Seq)
	}
	if fmt.Sprint(got) != "[0 1 2]" {
		t.Fatalf("got %v", got)
	}

	// Messages, then a status.
	stream, _ = cc.NewStream(context.Background(), desc, "/test.Echo/Count")
	_ = stream.SendMsg(&echoReq{Text: "fail", Count: 1})
	_ = stream.CloseSend()
	if err := stream.RecvMsg(new(echoReply)); err != nil {
		t.Fatal(err)
	}
	if err := stream.RecvMsg(new(echoReply)); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("got %v", err)
	}

	// The client cancels: Recv fails CANCELED, the handler's context ends.
	ctx, cancel := context.WithCancel(context.Background())
	stream, _ = cc.NewStream(ctx, desc, "/test.Echo/Count")
	_ = stream.SendMsg(&echoReq{Text: "wait", Count: 1})
	_ = stream.CloseSend()
	if err := stream.RecvMsg(new(echoReply)); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := stream.RecvMsg(new(echoReply)); status.Code(err) != codes.Canceled {
		t.Fatalf("got %v", err)
	}
	calls := CallsTo("Count", "")
	deadline := time.Now().Add(time.Second)
	for !calls[2].Done && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
		calls = CallsTo("Count", "")
	}
	if calls[2].Code != codes.Canceled {
		t.Fatalf("call %+v", calls[2])
	}
}

func TestClientStreamingAndBidi(t *testing.T) {
	setup(t)
	PeerServer("").RegisterService(&echoDesc, &echo{})
	cc := dial(t, "e:1")
	stream, err := cc.NewStream(context.Background(), &echoDesc.Streams[1], "/test.Echo/Sum")
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []int32{1, 2, 3} {
		if err := stream.SendMsg(&echoReq{Count: n}); err != nil {
			t.Fatal(err)
		}
	}
	_ = stream.CloseSend()
	sum := new(echoReply)
	if err := stream.RecvMsg(sum); err != nil || sum.Seq != 6 {
		t.Fatalf("sum %+v, %v", sum, err)
	}

	chat, err := cc.NewStream(context.Background(), &echoDesc.Streams[2], "/test.Echo/Chat")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"a", "b"} {
		_ = chat.SendMsg(&echoReq{Text: s})
		m := new(echoReply)
		if err := chat.RecvMsg(m); err != nil || m.Text != "re: "+s {
			t.Fatalf("got %+v, %v", m, err)
		}
	}
	_ = chat.CloseSend()
	if err := chat.RecvMsg(new(echoReply)); err != io.EOF {
		t.Fatalf("after CloseSend: %v", err)
	}
}

func TestPeersByTargetAndStop(t *testing.T) {
	setup(t)
	a, b := &echo{}, &echo{}
	PeerServer("data-1:9100").RegisterService(&echoDesc, a)
	PeerServer("data-2:9100").RegisterService(&echoDesc, b)
	_ = dial(t, "data-2:9100").Invoke(context.Background(), "/test.Echo/Say", &echoReq{Text: "two"}, new(echoReply))
	if len(a.seen) != 0 || len(b.seen) != 1 {
		t.Fatalf("routing: a=%v b=%v", a.seen, b.seen)
	}
	StopPeer("data-2:9100")
	err := dial(t, "data-2:9100").Invoke(context.Background(), "/test.Echo/Say", &echoReq{}, new(echoReply))
	if status.Code(err) != codes.Unavailable {
		t.Fatalf("stopped peer: %v", err)
	}
	if n := len(CallsTo("Say", "data-2:9100")); n != 2 {
		t.Fatalf("CallsTo by target: %d", n)
	}
}

func TestHarnessCallsAreNotTheLearners(t *testing.T) {
	setup(t)
	PeerServer("").RegisterService(&echoDesc, &echo{})
	_ = HarnessClient("x:1").Invoke(context.Background(), "/test.Echo/Say", &echoReq{}, new(echoReply))
	_ = dial(t, "x:1").Invoke(context.Background(), "/test.Echo/Say", &echoReq{}, new(echoReply))
	if LearnerCalls() != 1 || len(Calls()) != 2 || !Calls()[0].FromHarness {
		t.Fatalf("learner calls %d, calls %+v", LearnerCalls(), Calls())
	}
}

func TestListenAddressesNormalise(t *testing.T) {
	setup(t)
	for _, addr := range []string{":50051", "0.0.0.0:50052", "localhost:50053", "127.0.0.1:50054", "[::]:50055"} {
		srv := NewServer()
		srv.RegisterService(&echoDesc, &echo{})
		lis, err := netx.Listen("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		served := make(chan error, 1)
		go func() { served <- srv.Serve(lis) }()
		port := addr[len(addr)-5:]
		for !Serving("/test.Echo/Say", "notes:"+port) {
			time.Sleep(time.Millisecond)
		}
		if err := dial(t, "notes:"+port).Invoke(context.Background(), "/test.Echo/Say", &echoReq{}, new(echoReply)); err != nil {
			t.Fatalf("%s: %v", addr, err)
		}
		if _, err := netx.Listen("tcp", addr); err == nil {
			t.Fatalf("%s: listening twice must fail", addr)
		}
		srv.Stop()
		if err := await(t, served); err != nil {
			t.Fatalf("Serve after Stop: %v", err)
		}
	}
}
