// What generated code is built on: grpc::Service (a server's handlers by method path), the handler
// adapters for the four kinds of method, the unary client call, StubOptions.
#pragma once

#include <functional>
#include <string>
#include <vector>

#include <grpcpp/client_context.h>
#include <grpcpp/impl/call.h>
#include <grpcpp/server_context.h>
#include <grpcpp/support/status.h>
#include <grpcpp/support/sync_stream.h>

namespace grpc {

class StubOptions {
 public:
  StubOptions() = default;
  explicit StubOptions(const char* suffix_for_stats) { (void)suffix_for_stats; }
};

namespace internal {

class RpcMethod {
 public:
  enum RpcType { NORMAL_RPC = 0, CLIENT_STREAMING, SERVER_STREAMING, BIDI_STREAMING };
};

using MethodHandler = std::function<Status(ServerContext*, ServerCall&)>;

Status MissingRequest();
Status BadRequest();

template <class S, class Req, class Resp>
MethodHandler UnaryHandler(S* service, Status (S::*method)(ServerContext*, const Req*, Resp*)) {
  return [service, method](ServerContext* context, ServerCall& call) {
    std::string bytes;
    if (!call.Read(&bytes)) return MissingRequest();
    Req request;
    if (!request.ParseFromString(bytes)) return BadRequest();
    Resp response;
    Status status = (service->*method)(context, &request, &response);
    if (status.ok()) call.Write(response.SerializeAsString());
    return status;
  };
}

template <class S, class Req, class Resp>
MethodHandler ServerStreamingHandler(S* service, Status (S::*method)(ServerContext*, const Req*, ServerWriter<Resp>*)) {
  return [service, method](ServerContext* context, ServerCall& call) {
    std::string bytes;
    if (!call.Read(&bytes)) return MissingRequest();
    Req request;
    if (!request.ParseFromString(bytes)) return BadRequest();
    ServerWriter<Resp> writer(&call);
    return (service->*method)(context, &request, &writer);
  };
}

template <class S, class Req, class Resp>
MethodHandler ClientStreamingHandler(S* service, Status (S::*method)(ServerContext*, ServerReader<Req>*, Resp*)) {
  return [service, method](ServerContext* context, ServerCall& call) {
    ServerReader<Req> reader(&call);
    Resp response;
    Status status = (service->*method)(context, &reader, &response);
    if (status.ok()) call.Write(response.SerializeAsString());
    return status;
  };
}

template <class S, class Req, class Resp>
MethodHandler BidiStreamingHandler(S* service, Status (S::*method)(ServerContext*, ServerReaderWriter<Resp, Req>*)) {
  return [service, method](ServerContext* context, ServerCall& call) {
    ServerReaderWriter<Resp, Req> stream(&call);
    return (service->*method)(context, &stream);
  };
}

template <class Req, class Resp>
Status BlockingUnaryCall(ChannelInterface* channel, const char* method, ClientContext* context, const Req& request,
                         Resp* response) {
  std::string bytes;
  Status status = UnaryCall(channel, method, context, request.SerializeAsString(), &bytes);
  if (status.ok() && !response->ParseFromString(bytes)) return Status(StatusCode::INTERNAL, "Failed to parse response");
  return status;
}

}  // namespace internal

class Service {
 public:
  struct LbMethod {
    std::string path;  // "/pkg.Service/Method"
    internal::RpcMethod::RpcType type;
    internal::MethodHandler handler;
  };

  Service() = default;
  virtual ~Service() = default;
  Service(const Service&) = delete;
  Service& operator=(const Service&) = delete;

  const std::vector<LbMethod>& lb_methods() const { return methods_; }

 protected:
  void AddMethod(std::string path, internal::RpcMethod::RpcType type, internal::MethodHandler handler) {
    methods_.push_back({std::move(path), type, std::move(handler)});
  }

 private:
  std::vector<LbMethod> methods_;
};

}  // namespace grpc
