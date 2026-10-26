// gRPC's channel and call credentials. Calls run in process: TLS is accepted and nothing is
// encrypted; call credentials (an access token) add their metadata to every call they cover.
#pragma once

#include <map>
#include <memory>
#include <string>
#include <utility>

namespace grpc {

class CallCredentials {
 public:
  explicit CallCredentials(std::multimap<std::string, std::string> metadata) : metadata_(std::move(metadata)) {}
  virtual ~CallCredentials() = default;
  const std::multimap<std::string, std::string>& lb_metadata() const { return metadata_; }

 private:
  std::multimap<std::string, std::string> metadata_;
};

class ChannelCredentials {
 public:
  explicit ChannelCredentials(bool secure, std::shared_ptr<CallCredentials> call = nullptr)
      : secure_(secure), call_(std::move(call)) {}
  virtual ~ChannelCredentials() = default;
  bool lb_secure() const { return secure_; }
  const std::shared_ptr<CallCredentials>& lb_call() const { return call_; }

 private:
  bool secure_;
  std::shared_ptr<CallCredentials> call_;
};

struct SslCredentialsOptions {
  std::string pem_root_certs;
  std::string pem_private_key;
  std::string pem_cert_chain;
};

std::shared_ptr<ChannelCredentials> InsecureChannelCredentials();
std::shared_ptr<ChannelCredentials> SslCredentials(const SslCredentialsOptions& options);
std::shared_ptr<ChannelCredentials> GoogleDefaultCredentials();
std::shared_ptr<CallCredentials> AccessTokenCredentials(const std::string& access_token);
std::shared_ptr<ChannelCredentials> CompositeChannelCredentials(const std::shared_ptr<ChannelCredentials>& channel_creds,
                                                                const std::shared_ptr<CallCredentials>& call_creds);
std::shared_ptr<CallCredentials> CompositeCallCredentials(const std::shared_ptr<CallCredentials>& a,
                                                          const std::shared_ptr<CallCredentials>& b);

namespace experimental {
std::shared_ptr<ChannelCredentials> LocalCredentials(int type = 0);
}

}  // namespace grpc
