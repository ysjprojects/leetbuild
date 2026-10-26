// grpc::Server: serves its registered services to the calls that reach it, each handler on a
// green thread of its own. A learner's server is reached at the port it listens on.
#pragma once

#include <memory>

#include <grpcpp/impl/service_type.h>
#include <grpcpp/impl/time.h>

namespace grpc {

namespace internal {
struct ServerState;
}

class Server {
 public:
  explicit Server(std::shared_ptr<internal::ServerState> state);
  ~Server();
  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  // Block until the server is shut down.
  void Wait();
  // Stop taking calls and wait for the calls in flight to finish (at the deadline, cancel them).
  void Shutdown();
  template <class T>
  void Shutdown(const T& deadline) {
    lb_shutdown(internal::to_ms(deadline));
  }

  // The model's: add a service to a running server (how the harness's peers get theirs).
  bool RegisterService(Service* service);
  void lb_shutdown(double deadline_ms);
  const std::shared_ptr<internal::ServerState>& lb_state() const { return state_; }

 private:
  std::shared_ptr<internal::ServerState> state_;
};

}  // namespace grpc
