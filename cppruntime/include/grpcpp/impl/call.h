// The model's calls (implemented in cppruntime/src/grpc.cpp): a call in flight is both ends of a
// stream of serialized messages, its metadata, its deadline on virtual time and its status. A
// unary call is a stream of one request and one response. The typed streams
// (grpcpp/support/sync_stream.h) and the generated stubs and services sit on these.
#pragma once

#include <memory>
#include <string>

#include <grpcpp/support/status.h>

namespace grpc {

class ChannelInterface;
class ClientContext;
class ServerContext;

namespace internal {

struct Rpc;

// The caller's end.
class ClientCall {
 public:
  // Starts the call (a server-streaming call with its request, a client- or bidi-streaming one
  // without): logged, then failed by the harness, unreachable, or on its way to the server.
  ClientCall(ChannelInterface* channel, const char* method, ClientContext* context, bool client_streams,
             bool server_streams, const std::string* request);
  bool Write(const std::string& message);
  bool WritesDone();
  bool Read(std::string* message);
  // Waits for the call to end: its status (and, for a call with one response, that response).
  Status Finish(std::string* response);
  void WaitForInitialMetadata();

 private:
  std::shared_ptr<Rpc> rpc_;
};

Status UnaryCall(ChannelInterface* channel, const char* method, ClientContext* context, const std::string& request,
                 std::string* response);

// The handler's end.
class ServerCall {
 public:
  explicit ServerCall(std::shared_ptr<Rpc> rpc) : rpc_(std::move(rpc)) {}
  bool Read(std::string* message);
  bool Write(const std::string& message);
  void SendInitialMetadata();

 private:
  std::shared_ptr<Rpc> rpc_;
};

}  // namespace internal
}  // namespace grpc
