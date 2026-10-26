// The harness's side of gRPC (ctx.GRPC): servers it stands up for the learner's clients to call,
// clients of the learner's servers, the calls made, failures and latency injected. The Go harness's
// GRPC API (goruntime/harness/grpc.go), over the runtime's in-process gRPC (cppruntime/include/
// grpcpp). Implemented in cppruntime/src/harness_grpc.cpp.
//
//   NotesPeer peer;                                         // a notes::v1::Notes::Service
//   ctx.GRPC.Server("notes:50051")->RegisterService(&peer); // answers at once
//   auto stub = notes::v1::Notes::NewStub(ctx.GRPC.Dial("notes:50051"));
//   for (const harness::Call& c : ctx.GRPC.CallsTo("GetNote")) c.Request<notes::v1::GetNoteRequest>().id();
//
// Methods are named "/pkg.Service/Method" or just "Method"; target "" means every target. Calls
// the harness makes through Dial are not counted as the learner's.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include <grpcpp/impl/call_log.h>

namespace harness {

class Ctx;

// One RPC the world saw: Method, Target, Request<M>() (the first request), Metadata,
// Deadline/Timeout (HasDeadline()), Started, and once Done its Code and Message; FromHarness for
// the harness's own calls.
using Call = grpc::lb::CallRecord;

class GRPC {
 public:
  explicit GRPC(Ctx& ctx) : ctx_(ctx) {}

  // The peer at target ("" answers on every target), created on first use: register services on
  // it (->RegisterService(&impl)); they answer at once. The harness owns the implementations.
  grpc::Server* Server(const std::string& target);
  // Take the peer at target down: calls to it fail UNAVAILABLE from now on (calls in flight too).
  void Stop(const std::string& target);
  // Every call to method takes seconds of virtual time before reaching the server, at target ("":
  // everywhere). A caller's deadline shorter than that ends DEADLINE_EXCEEDED without reaching it.
  void SetLatency(const std::string& method, double seconds, const std::string& target = "");
  // The next `times` calls to method (at target, "" anywhere) fail with code and details ("" reads
  // as the code's name: "unavailable") before reaching any server.
  void Fail(const std::string& method, grpc::StatusCode code, const std::string& details = "", int times = 1,
            const std::string& target = "");
  // Drop the failures not injected yet.
  void ClearFailures();
  // The calls to method (to target unless ""), oldest first.
  std::vector<Call> CallsTo(const std::string& method, const std::string& target = "");
  // Every call so far, oldest first.
  std::vector<Call> Calls();
  // How many calls the learner's code made.
  int LearnerCalls();
  // Whether a server (the learner's, or a peer) serves method's service, reachable at target ("" anywhere).
  bool Serving(const std::string& method, const std::string& target = "");
  // A channel for the harness's own calls (into the learner's server at target, e.g.
  // "localhost:50051"); pass it to the generated NewStub.
  std::shared_ptr<grpc::Channel> Dial(const std::string& target);

 private:
  Ctx& ctx_;
};

}  // namespace harness
