package grpc

import (
	"strings"
	"sync"
	"time"

	"leetbuild/goruntime/models/grpc/codes"
	"leetbuild/goruntime/models/grpc/metadata"
	"leetbuild/goruntime/models/netx"
)

// The in-process world every call goes through (src/lib/runtime/ts/grpc.ts's REGISTRY): learner
// servers by the port they Serve on, harness peers by exact target ("" = every target), latency
// and failure rules, and the log of calls. A call to "host:port" reaches the peer at exactly that
// target, else the learner server listening on that port, else the any-target peer; none of them
// serving the method's service is UNAVAILABLE.
//
// The exported functions below are the harness's hooks (ctx.GRPC); they are left out of the
// interpreter's symbol table.

// Call is one RPC as the registry saw it.
type Call struct {
	Method      string      // "/pkg.Service/Method"
	Target      string      // what the client dialed (scheme stripped)
	Request     any         // a copy of the first request message (nil until the client sent one)
	Metadata    metadata.MD // what the client sent
	Deadline    time.Time   // zero without a deadline
	Timeout     time.Duration
	Started     time.Time
	Done        bool       // the call ended
	Code        codes.Code // its status, once Done
	Message     string     // its status message, once Done
	FromHarness bool       // made by the harness (into a learner server), not by the learner's code
}

// HasDeadline reports whether the caller attached a deadline.
func (c Call) HasDeadline() bool { return !c.Deadline.IsZero() }

type rule struct{ target, path string }

type failure struct {
	code    codes.Code
	details string
}

var reg = struct {
	mu       sync.Mutex
	learner  map[string]*Server // by netx key (port)
	peers    map[string]*Server // harness peers by target ("" = any)
	latency  map[rule]time.Duration
	failures map[rule][]failure
	calls    []*Call
}{
	learner:  map[string]*Server{},
	peers:    map[string]*Server{},
	latency:  map[rule]time.Duration{},
	failures: map[rule][]failure{},
}

// Reset empties the world before a check: servers stopped, peers gone, rules and calls cleared,
// listeners closed.
func Reset() {
	reg.mu.Lock()
	servers := make([]*Server, 0, len(reg.learner)+len(reg.peers))
	for _, s := range reg.learner {
		servers = append(servers, s)
	}
	for _, s := range reg.peers {
		servers = append(servers, s)
	}
	reg.learner = map[string]*Server{}
	reg.peers = map[string]*Server{}
	reg.latency = map[rule]time.Duration{}
	reg.failures = map[rule][]failure{}
	reg.calls = nil
	reg.mu.Unlock()
	for _, s := range servers {
		s.Stop()
	}
	netx.Reset()
}

// LearnerCalls counts the RPCs the learner's code made (not the harness's calls into learner servers).
func LearnerCalls() int {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	n := 0
	for _, c := range reg.calls {
		if !c.FromHarness {
			n++
		}
	}
	return n
}

// Calls returns a snapshot of every call so far, oldest first.
func Calls() []Call {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	out := make([]Call, len(reg.calls))
	for i, c := range reg.calls {
		out[i] = *c
	}
	return out
}

// CallsTo returns the calls whose method ends with method ("/pkg.Svc/M", "Svc/M" or "M"), to
// target when it is not "".
func CallsTo(method, target string) []Call {
	suffix := method
	if !strings.HasPrefix(suffix, "/") {
		suffix = "/" + suffix
	}
	target = normalizeTarget(target)
	var out []Call
	for _, c := range Calls() {
		if strings.HasSuffix(c.Method, suffix) && (target == "" || c.Target == target) {
			out = append(out, c)
		}
	}
	return out
}

// PeerServer returns the harness's server at target ("" = every target), created on first use:
// services registered on it answer at once (pb.RegisterXServer(grpc.PeerServer(t), impl)).
func PeerServer(target string) *Server {
	target = normalizeTarget(target)
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if s := reg.peers[target]; s != nil {
		return s
	}
	s := NewServer()
	s.peerTarget = target
	reg.peers[target] = s
	return s
}

// StopPeer takes the peer at target down: calls to it fail UNAVAILABLE from now on, calls in
// flight fail UNAVAILABLE.
func StopPeer(target string) {
	target = normalizeTarget(target)
	reg.mu.Lock()
	s := reg.peers[target]
	delete(reg.peers, target)
	reg.mu.Unlock()
	if s != nil {
		s.Stop()
	}
}

// SetLatency makes every call to method ("/pkg.Svc/M" or "M") take d of virtual time before
// reaching the server — at target, or everywhere for "".
func SetLatency(method string, d time.Duration, target string) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.latency[rule{normalizeTarget(target), rulePath(method)}] = d
}

// FailNext makes the next times calls to method (at target, or anywhere for "") fail with code and
// details before reaching any server; empty details read as the code's name in lower case.
func FailNext(method string, code codes.Code, details string, times int, target string) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	key := rule{normalizeTarget(target), rulePath(method)}
	for range times {
		reg.failures[key] = append(reg.failures[key], failure{code, details})
	}
}

// ClearFailures drops every pending injected failure.
func ClearFailures() {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.failures = map[rule][]failure{}
}

// Serving reports whether a call to method at target would reach a server registering its service
// (target "": any learner server or peer).
func Serving(method, target string) bool {
	path := rulePath(method)
	if target != "" {
		s, _ := resolve(path, normalizeTarget(target))
		return s != nil && s.serves(path)
	}
	reg.mu.Lock()
	servers := make([]*Server, 0, len(reg.learner)+len(reg.peers))
	for _, s := range reg.learner {
		servers = append(servers, s)
	}
	for _, s := range reg.peers {
		servers = append(servers, s)
	}
	reg.mu.Unlock()
	for _, s := range servers {
		if s.serves(path) {
			return true
		}
	}
	return false
}

// HarnessClient returns a connection whose calls are the harness's own (not counted as the
// learner's), e.g. into the learner's server.
func HarnessClient(target string) *ClientConn {
	cc, _ := NewClient(target, WithInsecure())
	cc.harness = true
	return cc
}

// rulePath normalises a method name for rules: "/pkg.Svc/M" as is, "pkg.Svc/M" → "/pkg.Svc/M",
// "M" → "/M" (matching that method on every service).
func rulePath(method string) string {
	if strings.HasPrefix(method, "/") {
		return method
	}
	return "/" + method
}

// normalizeTarget strips a resolver scheme: "dns:///keys:9000" → "keys:9000".
func normalizeTarget(target string) string {
	for _, scheme := range []string{"dns:", "passthrough:"} {
		if rest, ok := strings.CutPrefix(target, scheme); ok {
			if r, ok := strings.CutPrefix(rest, "//"); ok { // scheme://authority/endpoint
				if i := strings.Index(r, "/"); i >= 0 {
					return r[i+1:]
				}
				return r
			}
			return rest
		}
	}
	return target
}

// listenKey is the netx key a client target reaches: its port, or "unix:path".
func listenKey(target string) string {
	if p, ok := strings.CutPrefix(target, "unix://"); ok {
		return "unix:" + p
	}
	if p, ok := strings.CutPrefix(target, "unix:"); ok {
		return "unix:" + p
	}
	key, err := netx.Key("tcp", target)
	if err != nil {
		return ""
	}
	return key
}

// resolve finds the server a call to path at target reaches: the peer at target, the learner
// server on its port, the any-target peer — the first serving path's service, else the first that
// exists (it answers UNIMPLEMENTED). It also reports the peer target used ("" for learner servers).
func resolve(path, target string) (*Server, string) {
	reg.mu.Lock()
	var candidates []*Server
	if s := reg.peers[target]; s != nil {
		candidates = append(candidates, s)
	}
	if key := listenKey(target); key != "" {
		if s := reg.learner[key]; s != nil {
			candidates = append(candidates, s)
		}
	}
	if s := reg.peers[""]; s != nil && target != "" {
		candidates = append(candidates, s)
	}
	reg.mu.Unlock()
	for _, s := range candidates {
		if s.serves(path) {
			return s, s.peerTarget
		}
	}
	if len(candidates) > 0 {
		return candidates[0], candidates[0].peerTarget
	}
	return nil, ""
}

// lookupLatency returns the latency rule for path at target: target-specific before global, full
// path before the bare method name.
func lookupLatency(path, target string) time.Duration {
	short := path[strings.LastIndex(path, "/"):]
	reg.mu.Lock()
	defer reg.mu.Unlock()
	for _, t := range []string{target, ""} {
		for _, p := range []string{path, short} {
			if d, ok := reg.latency[rule{t, p}]; ok {
				return d
			}
		}
		if target == "" {
			break
		}
	}
	return 0
}

// popFailure takes the next injected failure for path at target, in lookupLatency's order.
func popFailure(path, target string) (failure, bool) {
	short := path[strings.LastIndex(path, "/"):]
	reg.mu.Lock()
	defer reg.mu.Unlock()
	for _, t := range []string{target, ""} {
		for _, p := range []string{path, short} {
			key := rule{t, p}
			if q := reg.failures[key]; len(q) > 0 {
				reg.failures[key] = q[1:]
				return q[0], true
			}
		}
		if target == "" {
			break
		}
	}
	return failure{}, false
}

func record(c *Call) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.calls = append(reg.calls, c)
}

// update changes a recorded call under the registry's lock.
func update(c *Call, f func(*Call)) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	f(c)
}

func registerLearner(key string, s *Server) bool {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if reg.learner[key] != nil && reg.learner[key] != s {
		return false
	}
	reg.learner[key] = s
	return true
}

func unregister(s *Server) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	for k, v := range reg.learner {
		if v == s {
			delete(reg.learner, k)
		}
	}
	for k, v := range reg.peers {
		if v == s {
			delete(reg.peers, k)
		}
	}
}
