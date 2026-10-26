// grpc::ClientContext: one call's options (deadline, metadata) and, once it ran, what the server
// sent besides messages. Deadlines are on the runtime's virtual clock.
#pragma once

#include <chrono>
#include <map>
#include <memory>
#include <string>

#include <grpcpp/impl/time.h>
#include <grpcpp/security/credentials.h>
#include <grpcpp/support/string_ref.h>

namespace grpc {

class ServerContext;

namespace internal {
struct Rpc;
struct Access;
}  // namespace internal

class PropagationOptions {
 public:
  PropagationOptions& enable_deadline_propagation() { deadline_ = true; return *this; }
  PropagationOptions& disable_deadline_propagation() { deadline_ = false; return *this; }
  PropagationOptions& enable_cancellation_propagation() { return *this; }
  PropagationOptions& disable_cancellation_propagation() { return *this; }
  bool deadline_propagation() const { return deadline_; }

 private:
  bool deadline_ = true;
};

class ClientContext {
 public:
  ClientContext();
  ~ClientContext();
  ClientContext(const ClientContext&) = delete;
  ClientContext& operator=(const ClientContext&) = delete;

  // A context for a call made while serving one: the deadline carries over.
  static std::unique_ptr<ClientContext> FromServerContext(const ServerContext& server_context,
                                                          PropagationOptions options = PropagationOptions());

  void AddMetadata(const std::string& meta_key, const std::string& meta_value);
  template <class T>
  void set_deadline(const T& deadline) {
    deadline_ms_ = internal::to_ms(deadline);
  }
  std::chrono::system_clock::time_point deadline() const { return internal::from_ms(deadline_ms_); }
  void set_wait_for_ready(bool) {}
  void set_fail_fast(bool) {}
  void set_idempotent(bool) {}
  void set_cacheable(bool) {}
  void set_compression_algorithm(int) {}
  void set_authority(const std::string& authority) { authority_ = authority; }
  void set_credentials(const std::shared_ptr<CallCredentials>& creds) { creds_ = creds; }
  std::shared_ptr<CallCredentials> credentials() { return creds_; }

  // Cancel the call in flight: both ends see CANCELLED.
  void TryCancel();

  const std::multimap<string_ref, string_ref>& GetServerInitialMetadata() const;
  const std::multimap<string_ref, string_ref>& GetServerTrailingMetadata() const;
  std::string peer() const;

 private:
  friend struct internal::Access;
  std::multimap<std::string, std::string> metadata_;
  double deadline_ms_;
  std::string authority_;
  std::shared_ptr<CallCredentials> creds_;
  std::shared_ptr<internal::Rpc> rpc_;
  mutable std::multimap<std::string, std::string> initial_, trailing_;
  mutable std::multimap<string_ref, string_ref> initial_view_, trailing_view_;
};

}  // namespace grpc
