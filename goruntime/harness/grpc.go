package harness

import (
	"time"

	"leetbuild/goruntime/models/grpc"
	"leetbuild/goruntime/models/grpc/codes"
)

// GRPC is the check's handle on the in-process gRPC world (ctx.grpc in the TypeScript harness):
// peers the learner's clients reach, latency and failures injected on the virtual clock, the log of
// calls, and connections from the harness into the learner's servers.
//
// A peer is registered the way a server is in Go, through the generated code:
//
//	pb.RegisterKeyServiceServer(ctx.GRPC.Server("keys:9000"), &keyPeer{})
//
// (A ServiceDesc plus an implementation cannot be handed over directly: native code cannot call
// the methods of an interpreted value, so the generated Register function binds them.)
//
// Methods are named "/pkg.Service/Method" or just "Method"; target "" means every target.
// Calls the harness makes through Dial are not counted as the learner's.
type GRPC struct{ ctx *Ctx }

func newGRPC(c *Ctx) *GRPC { return &GRPC{ctx: c} }

// Call is one RPC the registry saw: Method, Target, Request (a copy of the first request),
// Metadata, Deadline/Timeout (HasDeadline), Started, and once Done its Code and Message;
// FromHarness for the harness's own calls.
type Call = grpc.Call

// Server returns the peer at target ("" answers on every target), created on first use; register
// services on it with the generated pb.RegisterXServer. They answer at once.
func (g *GRPC) Server(target string) *grpc.Server { return grpc.PeerServer(target) }

// Stop takes the peer at target down: calls to it fail UNAVAILABLE from now on (calls in flight too).
func (g *GRPC) Stop(target string) { grpc.StopPeer(target) }

// SetLatency makes every call to method take seconds of virtual time before reaching the server,
// at target ("" everywhere). A caller's deadline shorter than that fails DEADLINE_EXCEEDED without
// reaching the handler.
func (g *GRPC) SetLatency(method string, seconds float64, target string) {
	grpc.SetLatency(method, time.Duration(seconds*float64(time.Second)), target)
}

// Fail makes the next times calls to method (at target, "" anywhere) fail with code and details
// ("" reads as the code's name: "unavailable") before reaching any server.
func (g *GRPC) Fail(method string, code codes.Code, details string, times int, target string) {
	grpc.FailNext(method, code, details, times, target)
}

// ClearFailures drops the failures not injected yet (Python's ctx.grpc.failures.clear()).
func (g *GRPC) ClearFailures() { grpc.ClearFailures() }

// CallsTo returns the calls to method (to target unless ""), oldest first.
func (g *GRPC) CallsTo(method, target string) []Call { return grpc.CallsTo(method, target) }

// Calls returns every call so far, oldest first.
func (g *GRPC) Calls() []Call { return grpc.Calls() }

// LearnerCalls counts the calls the learner's code made.
func (g *GRPC) LearnerCalls() int { return grpc.LearnerCalls() }

// Serving reports whether a server (the learner's, or a peer) serves method's service, reachable
// at target ("" anywhere) — Python's ctx.grpc.find(path) is not None.
func (g *GRPC) Serving(method, target string) bool { return grpc.Serving(method, target) }

// Dial returns a connection for the harness's own calls (into the learner's server at target,
// e.g. "localhost:50051"); pass it to the generated pb.NewXClient.
func (g *GRPC) Dial(target string) *grpc.ClientConn { return grpc.HarnessClient(target) }
