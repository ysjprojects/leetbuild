// grpc::ServerContext: what a handler knows about its call (the client's metadata, deadline,
// whether it was cancelled) and the metadata it sends back.
#pragma once

#include <chrono>
#include <map>
#include <memory>
#include <string>

#include <grpcpp/impl/time.h>
#include <grpcpp/support/string_ref.h>

namespace grpc {

namespace internal {
struct Rpc;
struct Access;
}  // namespace internal

class ServerContext {
 public:
  ServerContext() = default;
  ServerContext(const ServerContext&) = delete;
  ServerContext& operator=(const ServerContext&) = delete;

  // The caller's deadline: time_point::max() when it set none.
  std::chrono::system_clock::time_point deadline() const;
  void AddInitialMetadata(const std::string& key, const std::string& value);
  void AddTrailingMetadata(const std::string& key, const std::string& value);
  // Whether the call was cancelled: the client cancelled, its deadline passed, the server stopped.
  bool IsCancelled() const;
  void TryCancel() const;
  const std::multimap<string_ref, string_ref>& client_metadata() const { return client_metadata_; }
  std::string peer() const;
  void set_compression_algorithm(int) {}

 private:
  friend struct internal::Access;
  std::shared_ptr<internal::Rpc> rpc_;
  std::multimap<string_ref, string_ref> client_metadata_;
};

class CallbackServerContext : public ServerContext {};

}  // namespace grpc
