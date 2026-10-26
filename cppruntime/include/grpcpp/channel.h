// grpc::Channel: a virtual connection to a target. Nothing connects: each call is routed when it is
// made (to the server listening on the target's port, or a harness peer at the target), so a
// channel created before its server is up works once it is.
#pragma once

#include <chrono>
#include <memory>
#include <string>

#include <grpcpp/impl/time.h>
#include <grpcpp/security/credentials.h>

enum grpc_connectivity_state {
  GRPC_CHANNEL_IDLE,
  GRPC_CHANNEL_CONNECTING,
  GRPC_CHANNEL_READY,
  GRPC_CHANNEL_TRANSIENT_FAILURE,
  GRPC_CHANNEL_SHUTDOWN,
};

namespace grpc {

class ChannelInterface : public std::enable_shared_from_this<ChannelInterface> {
 public:
  virtual ~ChannelInterface() = default;
  // READY while something serves the target, else TRANSIENT_FAILURE.
  virtual grpc_connectivity_state GetState(bool try_to_connect) = 0;
  // Whether the channel is READY (it does not wait: nothing comes up while a thread blocks here).
  template <class T>
  bool WaitForConnected(T deadline) {
    (void)deadline;
    return GetState(true) == GRPC_CHANNEL_READY;
  }
  template <class T>
  bool WaitForStateChange(grpc_connectivity_state last_observed, T deadline) {
    (void)deadline;
    return GetState(true) != last_observed;
  }

  // The model's: the target as dialed (scheme stripped), whether the harness made the channel,
  // the call credentials every call carries.
  virtual const std::string& lb_target() const = 0;
  virtual bool lb_harness() const = 0;
  virtual const std::shared_ptr<CallCredentials>& lb_call_credentials() const = 0;
};

class Channel final : public ChannelInterface {
 public:
  Channel(std::string target, bool harness, std::shared_ptr<CallCredentials> call = nullptr);
  grpc_connectivity_state GetState(bool try_to_connect) override;
  std::string GetLoadBalancingPolicyName() const { return "pick_first"; }
  std::string GetServiceConfigJSON() const { return ""; }
  const std::string& lb_target() const override { return target_; }
  bool lb_harness() const override { return harness_; }
  const std::shared_ptr<CallCredentials>& lb_call_credentials() const override { return call_; }

 private:
  std::string target_;
  bool harness_;
  std::shared_ptr<CallCredentials> call_;
};

}  // namespace grpc
