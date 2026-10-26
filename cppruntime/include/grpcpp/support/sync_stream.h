// gRPC's synchronous streams: the client's ClientReader (server streaming), ClientWriter (client
// streaming), ClientReaderWriter (bidirectional), and the handler's ServerReader, ServerWriter,
// ServerReaderWriter. Messages cross serialized, so neither side shares memory with the other.
#pragma once

#include <cstdint>
#include <string>

#include <grpcpp/impl/call.h>
#include <grpcpp/support/status.h>

namespace grpc {

class WriteOptions {
 public:
  WriteOptions& set_no_compression() { return *this; }
  WriteOptions& clear_no_compression() { return *this; }
  WriteOptions& set_buffer_hint() { return *this; }
  WriteOptions& clear_buffer_hint() { return *this; }
  WriteOptions& set_corked() { return *this; }
  WriteOptions& clear_corked() { return *this; }
  WriteOptions& set_last_message() {
    last_ = true;
    return *this;
  }
  WriteOptions& clear_last_message() {
    last_ = false;
    return *this;
  }
  bool is_last_message() const { return last_; }

 private:
  bool last_ = false;
};

// ---- the client's ends ----------------------------------------------------------------------

template <class R>
class ClientReaderInterface {
 public:
  virtual ~ClientReaderInterface() = default;
  virtual bool Read(R* msg) = 0;
  virtual Status Finish() = 0;
  virtual void WaitForInitialMetadata() = 0;
  virtual bool NextMessageSize(uint32_t* sz) = 0;
};

template <class W>
class ClientWriterInterface {
 public:
  virtual ~ClientWriterInterface() = default;
  virtual bool Write(const W& msg, WriteOptions options) = 0;
  bool Write(const W& msg) { return Write(msg, WriteOptions()); }
  bool WriteLast(const W& msg, WriteOptions options) { return Write(msg, options.set_last_message()); }
  virtual bool WritesDone() = 0;
  virtual Status Finish() = 0;
};

template <class W, class R>
class ClientReaderWriterInterface {
 public:
  virtual ~ClientReaderWriterInterface() = default;
  virtual bool Write(const W& msg, WriteOptions options) = 0;
  bool Write(const W& msg) { return Write(msg, WriteOptions()); }
  bool WriteLast(const W& msg, WriteOptions options) { return Write(msg, options.set_last_message()); }
  virtual bool WritesDone() = 0;
  virtual bool Read(R* msg) = 0;
  virtual Status Finish() = 0;
  virtual void WaitForInitialMetadata() = 0;
  virtual bool NextMessageSize(uint32_t* sz) = 0;
};

template <class R>
class ClientReader final : public ClientReaderInterface<R> {
 public:
  template <class Req>
  ClientReader(ChannelInterface* channel, const char* method, ClientContext* context, const Req& request)
      : call_(channel, method, context, false, true, &static_cast<const std::string&>(request.SerializeAsString())) {}
  bool Read(R* msg) override {
    std::string bytes;
    return call_.Read(&bytes) && msg->ParseFromString(bytes);
  }
  Status Finish() override { return call_.Finish(nullptr); }
  void WaitForInitialMetadata() override { call_.WaitForInitialMetadata(); }
  bool NextMessageSize(uint32_t* sz) override {
    *sz = UINT32_MAX;
    return true;
  }

 private:
  internal::ClientCall call_;
};

template <class W>
class ClientWriter final : public ClientWriterInterface<W> {
 public:
  template <class Resp>
  ClientWriter(ChannelInterface* channel, const char* method, ClientContext* context, Resp* response)
      : call_(channel, method, context, true, false, nullptr),
        response_(response),
        parse_([](void* r, const std::string& b) { return static_cast<Resp*>(r)->ParseFromString(b); }) {}
  using ClientWriterInterface<W>::Write;
  bool Write(const W& msg, WriteOptions options) override {
    const bool ok = call_.Write(msg.SerializeAsString());
    if (ok && options.is_last_message()) call_.WritesDone();
    return ok;
  }
  bool WritesDone() override { return call_.WritesDone(); }
  Status Finish() override {
    std::string bytes;
    Status status = call_.Finish(&bytes);
    if (status.ok() && !parse_(response_, bytes)) return Status(StatusCode::INTERNAL, "Failed to parse response");
    return status;
  }
  void WaitForInitialMetadata() { call_.WaitForInitialMetadata(); }

 private:
  internal::ClientCall call_;
  void* response_;
  bool (*parse_)(void*, const std::string&);
};

template <class W, class R>
class ClientReaderWriter final : public ClientReaderWriterInterface<W, R> {
 public:
  ClientReaderWriter(ChannelInterface* channel, const char* method, ClientContext* context)
      : call_(channel, method, context, true, true, nullptr) {}
  using ClientReaderWriterInterface<W, R>::Write;
  bool Write(const W& msg, WriteOptions options) override {
    const bool ok = call_.Write(msg.SerializeAsString());
    if (ok && options.is_last_message()) call_.WritesDone();
    return ok;
  }
  bool WritesDone() override { return call_.WritesDone(); }
  bool Read(R* msg) override {
    std::string bytes;
    return call_.Read(&bytes) && msg->ParseFromString(bytes);
  }
  Status Finish() override { return call_.Finish(nullptr); }
  void WaitForInitialMetadata() override { call_.WaitForInitialMetadata(); }
  bool NextMessageSize(uint32_t* sz) override {
    *sz = UINT32_MAX;
    return true;
  }

 private:
  internal::ClientCall call_;
};

// ---- the handler's ends ---------------------------------------------------------------------

template <class R>
class ServerReaderInterface {
 public:
  virtual ~ServerReaderInterface() = default;
  virtual bool Read(R* msg) = 0;
  virtual void SendInitialMetadata() = 0;
  virtual bool NextMessageSize(uint32_t* sz) = 0;
};

template <class W>
class ServerWriterInterface {
 public:
  virtual ~ServerWriterInterface() = default;
  virtual bool Write(const W& msg, WriteOptions options) = 0;
  bool Write(const W& msg) { return Write(msg, WriteOptions()); }
  void WriteLast(const W& msg, WriteOptions options) { Write(msg, options.set_last_message()); }
  virtual void SendInitialMetadata() = 0;
};

template <class W, class R>
class ServerReaderWriterInterface {
 public:
  virtual ~ServerReaderWriterInterface() = default;
  virtual bool Write(const W& msg, WriteOptions options) = 0;
  bool Write(const W& msg) { return Write(msg, WriteOptions()); }
  void WriteLast(const W& msg, WriteOptions options) { Write(msg, options.set_last_message()); }
  virtual bool Read(R* msg) = 0;
  virtual void SendInitialMetadata() = 0;
  virtual bool NextMessageSize(uint32_t* sz) = 0;
};

template <class R>
class ServerReader final : public ServerReaderInterface<R> {
 public:
  explicit ServerReader(internal::ServerCall* call) : call_(call) {}
  bool Read(R* msg) override {
    std::string bytes;
    return call_->Read(&bytes) && msg->ParseFromString(bytes);
  }
  void SendInitialMetadata() override { call_->SendInitialMetadata(); }
  bool NextMessageSize(uint32_t* sz) override {
    *sz = UINT32_MAX;
    return true;
  }

 private:
  internal::ServerCall* call_;
};

template <class W>
class ServerWriter final : public ServerWriterInterface<W> {
 public:
  explicit ServerWriter(internal::ServerCall* call) : call_(call) {}
  using ServerWriterInterface<W>::Write;
  bool Write(const W& msg, WriteOptions) override { return call_->Write(msg.SerializeAsString()); }
  void SendInitialMetadata() override { call_->SendInitialMetadata(); }

 private:
  internal::ServerCall* call_;
};

template <class W, class R>
class ServerReaderWriter final : public ServerReaderWriterInterface<W, R> {
 public:
  explicit ServerReaderWriter(internal::ServerCall* call) : call_(call) {}
  using ServerReaderWriterInterface<W, R>::Write;
  bool Write(const W& msg, WriteOptions) override { return call_->Write(msg.SerializeAsString()); }
  bool Read(R* msg) override {
    std::string bytes;
    return call_->Read(&bytes) && msg->ParseFromString(bytes);
  }
  void SendInitialMetadata() override { call_->SendInitialMetadata(); }
  bool NextMessageSize(uint32_t* sz) override {
    *sz = UINT32_MAX;
    return true;
  }

 private:
  internal::ServerCall* call_;
};

}  // namespace grpc
