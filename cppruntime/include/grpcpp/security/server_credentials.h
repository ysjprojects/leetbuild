// gRPC's server credentials: insecure or TLS (accepted; calls run in process).
#pragma once

#include <memory>
#include <string>
#include <vector>

namespace grpc {

class ServerCredentials {
 public:
  explicit ServerCredentials(bool secure) : secure_(secure) {}
  virtual ~ServerCredentials() = default;
  bool lb_secure() const { return secure_; }

 private:
  bool secure_;
};

struct SslServerCredentialsOptions {
  struct PemKeyCertPair {
    std::string private_key;
    std::string cert_chain;
  };
  SslServerCredentialsOptions() = default;
  explicit SslServerCredentialsOptions(int) {}
  std::string pem_root_certs;
  std::vector<PemKeyCertPair> pem_key_cert_pairs;
  bool force_client_auth = false;
};

std::shared_ptr<ServerCredentials> InsecureServerCredentials();
std::shared_ptr<ServerCredentials> SslServerCredentials(const SslServerCredentialsOptions& options);

}  // namespace grpc
