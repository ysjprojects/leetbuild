// The model's in-process world as the harness sees it (ctx.GRPC, leetbuild/grpc.h): the log of
// calls, harness peers, latency and failures injected. The same rules as the Go runtime's registry
// (goruntime/models/grpc/registry.go): a call to "host:port" reaches the peer at exactly that
// target, else the learner's server listening on that port, else the any-target peer ("").
#pragma once

#include <chrono>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <grpcpp/support/status_code_enum.h>

namespace grpc {

class Server;
class Channel;

namespace lb {

// One RPC as the world saw it.
struct CallRecord {
  std::string Method;  // "/pkg.Service/Method"
  std::string Target;  // what the client dialed (scheme stripped)
  std::multimap<std::string, std::string> Metadata;  // what the client sent
  std::chrono::system_clock::time_point Deadline{};  // without one: the epoch (HasDeadline() false)
  std::chrono::nanoseconds Timeout{0};
  std::chrono::system_clock::time_point Started{};
  bool Done = false;
  StatusCode Code = StatusCode::OK;  // once Done
  std::string Message;               // once Done
  bool FromHarness = false;
  std::optional<std::string> request;  // the first request message, serialized

  bool HasDeadline() const { return has_deadline; }
  bool HasRequest() const { return request.has_value(); }
  // The first request as M (empty until the client sent one).
  template <class M>
  M Request() const {
    M m;
    if (request) m.ParseFromString(*request);
    return m;
  }
  // Timeout in seconds.
  double TimeoutSeconds() const { return std::chrono::duration<double>(Timeout).count(); }

  bool has_deadline = false;
};

Server* PeerServer(const std::string& target);
void StopPeer(const std::string& target);
void SetLatency(const std::string& method, double seconds, const std::string& target);
void FailNext(const std::string& method, StatusCode code, const std::string& details, int times, const std::string& target);
void ClearFailures();
std::vector<CallRecord> Calls();
std::vector<CallRecord> CallsTo(const std::string& method, const std::string& target);
int LearnerCalls();
bool Serving(const std::string& method, const std::string& target);
std::shared_ptr<Channel> HarnessChannel(const std::string& target);

}  // namespace lb
}  // namespace grpc
