// grpc::ServerBuilder: listening ports and services, then BuildAndStart (the server takes calls at
// once; nullptr when a port is taken).
#pragma once

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <grpcpp/impl/service_type.h>
#include <grpcpp/security/server_credentials.h>
#include <grpcpp/server.h>

namespace grpc {

class ServerBuilder {
 public:
  ServerBuilder& AddListeningPort(const std::string& addr_uri, std::shared_ptr<ServerCredentials> creds,
                                  int* selected_port = nullptr);
  ServerBuilder& RegisterService(Service* service);
  ServerBuilder& RegisterService(const std::string& host, Service* service) {
    (void)host;
    return RegisterService(service);
  }
  ServerBuilder& SetMaxReceiveMessageSize(int) { return *this; }
  ServerBuilder& SetMaxSendMessageSize(int) { return *this; }
  ServerBuilder& SetMaxMessageSize(int) { return *this; }
  ServerBuilder& SetDefaultCompressionAlgorithm(int) { return *this; }
  template <class T>
  ServerBuilder& AddChannelArgument(const std::string&, const T&) {
    return *this;
  }
  std::unique_ptr<Server> BuildAndStart();

 private:
  std::vector<std::pair<std::string, int*>> ports_;
  std::vector<Service*> services_;
};

// Accepted for course code that turns them on; the in-process server serves neither.
void EnableDefaultHealthCheckService(bool enable);
namespace reflection {
void InitProtoReflectionServerBuilderPlugin();
}

}  // namespace grpc
