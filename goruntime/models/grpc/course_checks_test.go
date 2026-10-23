package grpc_test

import "testing"

// url-shortener/key-service: a unary client with a deadline, retrying UNAVAILABLE once.
func TestCourseKeyService(t *testing.T) {
	code := solution(t, "url-shortener", "key-service")
	runChecks(t, "url-shortener", code, `package main

import (
	"context"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "shortener/gen/keys"
)

type keyPeer struct {
	pb.UnimplementedKeyServiceServer
	mu    sync.Mutex
	next  uint64
	block uint32
	sizes []uint32
}

func (p *keyPeer) ReserveBlock(ctx context.Context, req *pb.ReserveRequest) (*pb.ReserveReply, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sizes = append(p.sizes, req.GetSize())
	start := p.next
	p.next += 1000
	size := req.GetSize()
	if size > p.block {
		size = p.block
	}
	return &pb.ReserveReply{Start: start, Size: size}, nil
}

func serve(ctx *harness.Ctx, block uint32) *keyPeer {
	p := &keyPeer{next: 3842000, block: block}
	pb.RegisterKeyServiceServer(ctx.GRPC.Server("keys:9000"), p)
	return p
}

func rpcs(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("ReserveBlock", "")) }

func CheckDeadline(ctx *harness.Ctx) {
	serve(ctx, 1)
	code, err := nextCode(context.Background())
	ctx.NoError(err, "the first code")
	ctx.Equal(code, base62(3842000), "the first code")
	calls := ctx.GRPC.CallsTo("ReserveBlock", "keys:9000")
	ctx.Equal(len(calls), 1, "calls")
	ctx.Assert(calls[0].HasDeadline(), "ReserveBlock carries no deadline")
	ctx.Equal(calls[0].Timeout, 500*time.Millisecond, "the deadline")
	ctx.GRPC.SetLatency("ReserveBlock", 3, "")
	start := time.Now()
	_, err = nextCode(context.Background())
	ctx.Equal(status.Code(err), codes.DeadlineExceeded, "a slow key service")
	ctx.Equal(time.Since(start), 500*time.Millisecond, "time spent waiting")
	ctx.Equal(rpcs(ctx), 2, "DEADLINE_EXCEEDED is not retried")
	ctx.Equal(ctx.GRPC.LearnerCalls(), 2, "learner calls")
}

func CheckRetryUnavailable(ctx *harness.Ctx) {
	serve(ctx, 1)
	ctx.GRPC.Fail("ReserveBlock", codes.Unavailable, "key service restarting", 1, "")
	code, err := nextCode(context.Background())
	ctx.NoError(err, "one UNAVAILABLE must be retried")
	ctx.Equal(code, base62(3842000), "the code after a retry")
	ctx.Equal(rpcs(ctx), 2, "one retry")
	ctx.GRPC.Fail("ReserveBlock", codes.ResourceExhausted, "quota", 1, "")
	_, err = nextCode(context.Background())
	ctx.Equal(status.Code(err), codes.ResourceExhausted, "RESOURCE_EXHAUSTED propagates")
	ctx.Equal(status.Convert(err).Message(), "quota", "details")
	ctx.Equal(rpcs(ctx), 3, "no retry of RESOURCE_EXHAUSTED")
	ctx.GRPC.Fail("ReserveBlock", codes.Unavailable, "", 50, "")
	_, err = nextCode(context.Background())
	ctx.Equal(status.Code(err), codes.Unavailable, "a down key service")
	ctx.Equal(rpcs(ctx)-3, 2, "attempts against a down key service")
}

func CheckRefillWhenEmpty(ctx *harness.Ctx) {
	peer := serve(ctx, 3)
	for i := 0; i < 3; i++ {
		_, err := nextCode(context.Background())
		ctx.NoError(err, "code")
		ctx.Equal(rpcs(ctx), 1, "a block of 3 serves 3 codes")
	}
	_, _ = nextCode(context.Background())
	ctx.Equal(rpcs(ctx), 2, "the 4th code needs a block")
	ctx.Equal(peer.sizes, []uint32{1000, 1000}, "sizes asked for")
}

func CheckNoServer(ctx *harness.Ctx) {
	_, err := nextCode(context.Background())
	ctx.Equal(status.Code(err), codes.Unavailable, "nothing serves keys:9000")
}
`)
}

// grpc-metadata-auth/metadata-auth: a learner server reading incoming metadata.
func TestCourseMetadataAuth(t *testing.T) {
	code := solution(t, "grpc-metadata-auth", "metadata-auth")
	runChecks(t, "grpc-metadata-auth", code, `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "notes/gen/notes"
)

func rpc(ctx *harness.Ctx, client pb.NotesClient, token, method, id string) (codes.Code, string) {
	c := context.Background()
	if token != "" {
		c = metadata.AppendToOutgoingContext(c, "authorization", token)
	}
	c, cancel := context.WithTimeout(c, 2*time.Second)
	defer cancel()
	var err error
	if method == "get" {
		var note *pb.Note
		note, err = client.GetNote(c, &pb.GetNoteRequest{Id: id})
		if err == nil {
			return codes.OK, note.GetText()
		}
	} else {
		_, err = client.DeleteNote(c, &pb.DeleteNoteRequest{Id: id})
	}
	return status.Code(err), status.Convert(err).Message()
}

func CheckServesWithAuth(ctx *harness.Ctx) {
	ctx.Main(main)
	ctx.Assert(ctx.GRPC.Serving("/notes.v1.Notes/GetNote", "notes:50051"), "main must serve Notes on :50051")
	client := pb.NewNotesClient(ctx.GRPC.Dial("notes:50051"))
	for _, c := range []struct {
		token, method, id string
		want              codes.Code
	}{
		{"", "get", "n-1", codes.Unauthenticated},
		{"reader-7f3a", "get", "n-1", codes.Unauthenticated},
		{"Bearer guest-0000", "delete", "n-1", codes.Unauthenticated},
		{"Bearer reader-7f3a", "get", "n-1", codes.NotFound},
		{"Bearer reader-7f3a", "get", "", codes.InvalidArgument},
		{"Bearer reader-7f3a", "delete", "n-1", codes.PermissionDenied},
		{"Bearer admin-91c2", "delete", "n-1", codes.NotFound},
	} {
		got, details := rpc(ctx, client, c.token, c.method, c.id)
		ctx.Equal(got, c.want, "%s(%q) with %q (%s)", c.method, c.id, c.token, details)
	}
	ctx.Equal(ctx.GRPC.LearnerCalls(), 0, "the harness's calls are not the learner's")
	ctx.Equal(len(ctx.GRPC.Calls()), 7, "calls logged")
}

// The learner's server type, seeded and served as a peer: reads and deletes succeed.
func CheckSeeded(ctx *harness.Ctx) {
	pb.RegisterNotesServer(ctx.GRPC.Server("seeded:1"), &notesServer{notes: map[string]string{"n-1": "buy milk", "n-2": "ship"}})
	client := pb.NewNotesClient(ctx.GRPC.Dial("seeded:1"))
	got, text := rpc(ctx, client, "Bearer reader-7f3a", "get", "n-1")
	ctx.Equal(got, codes.OK, "reader reads: %s", text)
	ctx.Equal(text, "buy milk", "note text")
	got, _ = rpc(ctx, client, "Bearer admin-91c2", "delete", "n-2")
	ctx.Equal(got, codes.OK, "admin deletes")
	got, _ = rpc(ctx, client, "Bearer admin-91c2", "get", "n-2")
	ctx.Equal(got, codes.NotFound, "deleted")
}
`)
}

// grpc-deadline-propagation/propagate-deadline: a learner server calling a peer within the caller's deadline.
func TestCoursePropagateDeadline(t *testing.T) {
	code := solution(t, "grpc-deadline-propagation", "propagate-deadline")
	runChecks(t, "grpc-deadline-propagation", code, `package main

import (
	"context"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "quotes/gen/quotes"
)

type pricingPeer struct {
	pb.UnimplementedPricingServer
	mu        sync.Mutex
	budgets   []time.Duration
	cancelled int
}

var prices = map[string]int32{"kettle": 3499, "mug": 799}

func (p *pricingPeer) GetPrice(ctx context.Context, req *pb.PriceRequest) (*pb.Price, error) {
	p.mu.Lock()
	if dl, ok := ctx.Deadline(); ok {
		p.budgets = append(p.budgets, time.Until(dl))
	} else {
		p.budgets = append(p.budgets, -1)
	}
	p.mu.Unlock()
	unit, ok := prices[req.GetSku()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no price for %s", req.GetSku())
	}
	return &pb.Price{UnitCents: unit}, nil
}

func start(ctx *harness.Ctx) (*pricingPeer, pb.QuotesClient) {
	peer := &pricingPeer{}
	pb.RegisterPricingServer(ctx.GRPC.Server("pricing:50051"), peer)
	ctx.Main(main)
	return peer, pb.NewQuotesClient(ctx.GRPC.Dial("quotes:50050"))
}

func quote(client pb.QuotesClient, sku string, deadline time.Duration) (*pb.Quote, error) {
	c := context.Background()
	if deadline > 0 {
		var cancel context.CancelFunc
		c, cancel = context.WithTimeout(c, deadline)
		defer cancel()
	}
	return client.GetQuote(c, &pb.QuoteRequest{Sku: sku, Qty: 2})
}

func CheckPropagates(ctx *harness.Ctx) {
	peer, client := start(ctx)
	q, err := quote(client, "kettle", 800*time.Millisecond)
	ctx.NoError(err, "GetQuote")
	ctx.Equal(q.GetTotalCents(), 6998, "total")
	ctx.Equal(peer.budgets, []time.Duration{750 * time.Millisecond}, "the pricing call's budget")
	_, err = quote(client, "kettle", 0)
	ctx.NoError(err, "GetQuote without a deadline")
	ctx.Equal(peer.budgets[1], 950*time.Millisecond, "the default budget")
	calls := ctx.GRPC.CallsTo("GetPrice", "pricing:50051")
	ctx.Equal(len(calls), 2, "pricing calls")
	ctx.Equal(calls[0].Timeout, 750*time.Millisecond, "logged timeout")
	ctx.Equal(ctx.GRPC.LearnerCalls(), 2, "the learner's calls: the pricing ones")
}

func CheckErrors(ctx *harness.Ctx) {
	_, client := start(ctx)
	_, err := quote(client, "ghost", time.Second)
	ctx.Equal(status.Code(err), codes.NotFound, "an unknown sku")
	_, err = quote(client, "kettle", 40*time.Millisecond)
	ctx.Equal(status.Code(err), codes.DeadlineExceeded, "a budget below the reserve")
	ctx.GRPC.SetLatency("GetPrice", 5, "")
	_, err = quote(client, "kettle", time.Second)
	ctx.Equal(status.Code(err), codes.DeadlineExceeded, "a slow pricing service")
	ctx.GRPC.Stop("pricing:50051")
	_, err = quote(client, "kettle", time.Second)
	ctx.Equal(status.Code(err), codes.Unavailable, "pricing down")
	_, err = client.GetQuote(context.Background(), &pb.QuoteRequest{Sku: "", Qty: 1})
	ctx.Equal(status.Code(err), codes.InvalidArgument, "no sku")
}
`)
}

// live-chat/chat-stream: a bidirectional stream over the course's subscription table; the room
// bus (step 3's publish) is the harness's: it delivers locally.
func TestCourseChatStream(t *testing.T) {
	code := solution(t, "live-chat", "chat-stream")
	support := supportGo(t, "live-chat", "chat/subscriptions/subscriptions.go")
	runChecks(t, "live-chat", code, `package main

import (
	"context"
	"io"

	"chat/subscriptions"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"leetbuild/harness"

	pb "chat/gen/chat"
)

func localBus() {
	publish = func(ctx context.Context, room string, msg *pb.ServerMsg) error {
		subscriptions.LocalDeliver(room, msg)
		return nil
	}
}

func subscribers(room string) int { return subscriptions.Subscribers(room) }

func join(room, user string) *pb.ClientMsg {
	return &pb.ClientMsg{Kind: &pb.ClientMsg_Join{Join: &pb.Join{Room: room, User: user}}}
}

func say(text string) *pb.ClientMsg {
	return &pb.ClientMsg{Kind: &pb.ClientMsg_Say{Say: &pb.Say{Text: text}}}
}

func CheckChat(ctx *harness.Ctx) {
	localBus()
	ctx.Main(main)
	client := pb.NewChatClient(ctx.GRPC.Dial("chat:9000"))
	alice, err := client.Chat(context.Background())
	ctx.NoError(err, "alice's stream")
	bobCtx, bobCancel := context.WithCancel(context.Background())
	bob, err := client.Chat(bobCtx)
	ctx.NoError(err, "bob's stream")
	ctx.NoError(alice.Send(join("r1", "alice")), "alice joins")
	ctx.NoError(bob.Send(join("r1", "bob")), "bob joins")
	ctx.Settle()
	ctx.Equal(subscribers("r1"), 2, "subscribers after two joins")
	ctx.NoError(alice.Send(say("hi")), "alice says hi")
	m, err := bob.Recv()
	ctx.NoError(err, "bob receives")
	ctx.Equal([]string{m.GetRoom(), m.GetUser(), m.GetText()}, []string{"r1", "alice", "hi"}, "bob's message")
	m, err = alice.Recv()
	ctx.NoError(err, "alice receives her own message")
	ctx.Equal(m.GetText(), "hi", "alice's message")
	bobCancel()
	ctx.Settle()
	ctx.Equal(subscribers("r1"), 1, "bob's subscription after he hung up")
	ctx.NoError(alice.CloseSend(), "alice closes")
	_, err = alice.Recv()
	ctx.Equal(err, io.EOF, "the stream ends when alice closes her side")
	ctx.Settle()
	ctx.Equal(subscribers("r1"), 0, "subscriptions left")
	calls := ctx.GRPC.CallsTo("/chat.Chat/Chat", "")
	ctx.Equal(len(calls), 2, "streams")
	ctx.Equal(calls[1].Code, codes.Canceled, "bob's stream status")
}

func CheckFirstMessageMustJoin(ctx *harness.Ctx) {
	localBus()
	ctx.Main(main)
	client := pb.NewChatClient(ctx.GRPC.Dial("localhost:9000"))
	s, err := client.Chat(context.Background())
	ctx.NoError(err, "stream")
	ctx.NoError(s.Send(say("hello?")), "send")
	_, err = s.Recv()
	ctx.Equal(status.Code(err), codes.InvalidArgument, "a first message that is not a join")
}

func CheckMessagesEncode(ctx *harness.Ctx) {
	in := say("hi")
	b, err := proto.Marshal(in)
	ctx.NoError(err, "proto.Marshal")
	out := &pb.ClientMsg{}
	ctx.NoError(proto.Unmarshal(b, out), "proto.Unmarshal")
	ctx.Assert(out.GetSay() != nil && out.GetSay().GetText() == "hi" && out.GetJoin() == nil, "oneof round trip: %v", out)
	ctx.Assert(proto.Equal(in, out), "proto.Equal after the round trip")
	clone := proto.Clone(in).(*pb.ClientMsg)
	ctx.Equal(clone.GetSay().GetText(), "hi", "proto.Clone")
	j, err := protojson.Marshal(&pb.ServerMsg{Room: "r", User: "u", Text: "t", Ts: 1700000000000})
	ctx.NoError(err, "protojson.Marshal")
	ctx.Equal(string(j), `+"`"+`{"room":"r","user":"u","text":"t","ts":"1700000000000"}`+"`"+`, "protojson")
	back := &pb.ServerMsg{}
	ctx.NoError(protojson.Unmarshal(j, back), "protojson.Unmarshal")
	ctx.Equal(back.GetTs(), int64(1700000000000), "ts")
	j, _ = protojson.Marshal(join("r", "u"))
	ctx.Equal(string(j), `+"`"+`{"join":{"room":"r","user":"u"}}`+"`"+`, "a oneof in JSON")
	m := &pb.ClientMsg{}
	ctx.NoError(protojson.Unmarshal(j, m), "oneof from JSON")
	ctx.Equal(m.GetJoin().GetUser(), "u", "oneof from JSON")
	ctx.Assert(m.Kind != nil, "decoded oneof is set")
	switch m.Kind.(type) {
	case *pb.ClientMsg_Join:
	default:
		ctx.Fatalf("type switch on a decoded oneof")
	}
	ctx.Assert(len(in.String()) > 0, "String")
}
`, support)
}

// grpc-page-tokens/page-tokens: a learner server; the harness seeds its package-level shelves.
func TestCoursePageTokens(t *testing.T) {
	code := solution(t, "grpc-page-tokens", "page-tokens")
	runChecks(t, "grpc-page-tokens", code, `package main

import (
	"context"
	"fmt"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "library/gen/library"
)

func CheckPages(ctx *harness.Ctx) {
	shelf := map[string]string{}
	for i := 7; i >= 1; i-- {
		shelf[fmt.Sprintf("b-%04d", i)] = fmt.Sprintf("Title %d", i)
	}
	shelves["s"] = shelf
	ctx.Main(main)
	client := pb.NewLibraryClient(ctx.GRPC.Dial("library:9000"))
	var ids []string
	token := ""
	pages := 0
	for {
		reply, err := client.ListBooks(context.Background(), &pb.ListBooksRequest{Shelf: "s", PageSize: 3, PageToken: token})
		ctx.NoError(err, "page %d", pages)
		pages++
		for _, b := range reply.GetBooks() {
			ids = append(ids, b.GetId())
		}
		token = reply.GetNextPageToken()
		if token == "" {
			break
		}
	}
	ctx.Equal(pages, 3, "pages")
	ctx.Equal(ids, []string{"b-0001", "b-0002", "b-0003", "b-0004", "b-0005", "b-0006", "b-0007"}, "ids")
	_, err := client.ListBooks(context.Background(), &pb.ListBooksRequest{Shelf: "s", PageToken: "garbage"})
	ctx.Equal(status.Code(err), codes.InvalidArgument, "a forged token")
	_, err = client.ListBooks(context.Background(), &pb.ListBooksRequest{Shelf: "s", PageSize: -1})
	ctx.Equal(status.Code(err), codes.InvalidArgument, "a negative page size")
	_, err = client.ListBooks(context.Background(), &pb.ListBooksRequest{Shelf: "nope"})
	ctx.Equal(status.Code(err), codes.NotFound, "an unknown shelf")
}
`)
}

// grpc-resumable-stream/resumable-upload: a bidirectional client resuming after UNAVAILABLE.
func TestCourseResumableUpload(t *testing.T) {
	code := solution(t, "grpc-resumable-stream", "resumable-upload")
	runChecks(t, "grpc-resumable-stream", code, `package main

import (
	"context"
	"io"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "ingest/gen/ingest"
)

type ingestPeer struct {
	pb.UnimplementedIngestServer
	mu        sync.Mutex
	committed int32
	failAt    int32
	streams   int
}

func (p *ingestPeer) GetStatus(ctx context.Context, req *pb.StatusRequest) (*pb.StatusResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return &pb.StatusResponse{NextSeq: p.committed}, nil
}

func (p *ingestPeer) Upload(stream pb.Ingest_UploadServer) error {
	p.mu.Lock()
	p.streams++
	first := p.streams == 1
	p.mu.Unlock()
	for {
		c, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		p.mu.Lock()
		if c.GetSeq() != p.committed {
			p.mu.Unlock()
			return status.Error(codes.FailedPrecondition, "out of order")
		}
		if first && c.GetSeq() == p.failAt {
			p.mu.Unlock()
			return status.Error(codes.Unavailable, "ingest restarting")
		}
		p.committed++
		p.mu.Unlock()
		if err := stream.Send(&pb.Ack{Seq: c.GetSeq()}); err != nil {
			return err
		}
	}
}

func CheckResumes(ctx *harness.Ctx) {
	peer := &ingestPeer{failAt: 2}
	pb.RegisterIngestServer(ctx.GRPC.Server("ingest:9000"), peer)
	conn, err := grpc.NewClient("ingest:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	ctx.NoError(err, "NewClient")
	chunks := [][]byte{[]byte("a"), []byte("b"), []byte("c"), []byte("d"), []byte("e")}
	start := time.Now()
	attempts, err := upload(context.Background(), pb.NewIngestClient(conn), "u1", chunks, 3)
	ctx.NoError(err, "upload")
	ctx.Equal(attempts, 2, "attempts")
	ctx.Equal(peer.committed, int32(5), "committed chunks")
	ctx.Equal(peer.streams, 2, "streams")
	ctx.Equal(time.Since(start), 100*time.Millisecond, "the backoff before the second attempt")
	calls := ctx.GRPC.CallsTo("Upload", "")
	ctx.Equal(calls[0].Code, codes.Unavailable, "the first stream's status")
	ctx.Equal(ctx.GRPC.LearnerCalls(), 4, "GetStatus, Upload, GetStatus, Upload")
}

func CheckGivesUp(ctx *harness.Ctx) {
	peer := &ingestPeer{failAt: 0}
	pb.RegisterIngestServer(ctx.GRPC.Server("ingest:9000"), peer)
	ctx.GRPC.Fail("Upload", codes.Unavailable, "", 10, "")
	conn, _ := grpc.NewClient("ingest:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	attempts, err := upload(context.Background(), pb.NewIngestClient(conn), "u1", [][]byte{[]byte("a")}, 3)
	ctx.Equal(status.Code(err), codes.Unavailable, "after the last attempt")
	ctx.Equal(attempts, 3, "attempts")
}
`)
}

// grpc-outlier-ejection/outlier-ejection: a client balancing over peers by target, ejecting the
// ones that fail at the transport.
func TestCourseOutlierEjection(t *testing.T) {
	code := solution(t, "grpc-outlier-ejection", "outlier-ejection")
	runChecks(t, "grpc-outlier-ejection", code, `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "inventory/gen/inventory"
)

var stock = map[string]int32{"sku-1": 7, "sku-2": 42}

type inventoryPeer struct {
	pb.UnimplementedInventoryServer
}

func (inventoryPeer) GetStock(ctx context.Context, req *pb.StockRequest) (*pb.Stock, error) {
	n, ok := stock[req.GetSku()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no sku %s", req.GetSku())
	}
	return &pb.Stock{Sku: req.GetSku(), Count: n}, nil
}

func serve(ctx *harness.Ctx) *Balancer {
	for _, t := range targets {
		pb.RegisterInventoryServer(ctx.GRPC.Server(t), inventoryPeer{})
	}
	return NewBalancer(targets)
}

func made(ctx *harness.Ctx, from int) []string {
	var out []string
	for _, c := range ctx.GRPC.CallsTo("GetStock", "")[from:] {
		out = append(out, c.Target)
	}
	return out
}

func CheckRoundRobin(ctx *harness.Ctx) {
	b := serve(ctx)
	for i := 0; i < 3; i++ {
		n, err := b.GetStock(context.Background(), "sku-2")
		ctx.NoError(err, "GetStock")
		ctx.Equal(n, 42, "count")
	}
	ctx.Equal(made(ctx, 0), []string{"inv-a:50051", "inv-b:50051", "inv-c:50051"}, "targets")
	_, err := b.GetStock(context.Background(), "ghost")
	ctx.Equal(status.Code(err), codes.NotFound, "NOT_FOUND is the request's fault")
	ctx.Equal(len(made(ctx, 3)), 1, "no failover on NOT_FOUND")
}

func CheckEjects(ctx *harness.Ctx) {
	b := serve(ctx)
	ctx.GRPC.Stop("inv-b:50051")
	ctx.GRPC.SetLatency("GetStock", 1, "inv-c:50051")
	for i := 0; i < 2; i++ {
		_, err := b.GetStock(context.Background(), "sku-1")
		ctx.NoError(err, "GetStock %d", i)
	}
	ctx.Equal(made(ctx, 0), []string{"inv-a:50051", "inv-b:50051", "inv-c:50051", "inv-a:50051"}, "failover order")
	calls := ctx.GRPC.CallsTo("GetStock", "inv-c:50051")
	ctx.Equal(calls[0].Code, codes.DeadlineExceeded, "the slow instance")
	ctx.Equal(calls[0].Timeout, 200*time.Millisecond, "per-attempt deadline")
	before := len(made(ctx, 0))
	_, err := b.GetStock(context.Background(), "sku-1")
	ctx.NoError(err, "a third GetStock")
	ctx.Equal(made(ctx, before), []string{"inv-a:50051"}, "ejected targets get no calls")
}
`)
}
