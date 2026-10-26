// grpc::ChannelArguments: a channel's options. Calls run in process, so they change nothing here
// but are kept (GetSslTargetNameOverride, the user agent).
#pragma once

#include <map>
#include <string>

namespace grpc {

class ChannelArguments {
 public:
  void SetInt(const std::string& key, int value) { ints_[key] = value; }
  void SetString(const std::string& key, const std::string& value) { strings_[key] = value; }
  void SetPointer(const std::string&, void*) {}
  void SetMaxReceiveMessageSize(int size) { SetInt("grpc.max_receive_message_length", size); }
  void SetMaxSendMessageSize(int size) { SetInt("grpc.max_send_message_length", size); }
  void SetCompressionAlgorithm(int algorithm) { SetInt("grpc.default_compression_algorithm", algorithm); }
  void SetLoadBalancingPolicyName(const std::string& name) { SetString("grpc.lb_policy_name", name); }
  void SetServiceConfigJSON(const std::string& json) { SetString("grpc.service_config", json); }
  void SetUserAgentPrefix(const std::string& prefix) { SetString("grpc.primary_user_agent", prefix); }
  void SetSslTargetNameOverride(const std::string& name) { SetString("grpc.ssl_target_name_override", name); }
  std::string GetSslTargetNameOverride() const {
    auto it = strings_.find("grpc.ssl_target_name_override");
    return it == strings_.end() ? "" : it->second;
  }

 private:
  std::map<std::string, int> ints_;
  std::map<std::string, std::string> strings_;
};

}  // namespace grpc
