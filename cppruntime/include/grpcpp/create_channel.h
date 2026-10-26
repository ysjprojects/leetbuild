// grpc::CreateChannel / CreateCustomChannel.
#pragma once

#include <memory>
#include <string>

#include <grpcpp/channel.h>
#include <grpcpp/security/credentials.h>
#include <grpcpp/support/channel_arguments.h>

namespace grpc {

std::shared_ptr<Channel> CreateChannel(const std::string& target, const std::shared_ptr<ChannelCredentials>& creds);
std::shared_ptr<Channel> CreateCustomChannel(const std::string& target, const std::shared_ptr<ChannelCredentials>& creds,
                                             const ChannelArguments& args);

}  // namespace grpc
