// gRPC C++ (grpc++) for the LeetBuild runtime: channels, stubs, servers and streams in process. A
// call from a stub runs its handler on a green thread of its own; deadlines expire on the runtime's
// virtual clock; messages cross serialized. The harness reaches the same world through ctx.GRPC
// (leetbuild/grpc.h): its peers, latency and failures, the log of calls.
// Implemented in cppruntime/src/grpc.cpp.
#pragma once

#include <grpcpp/channel.h>
#include <grpcpp/client_context.h>
#include <grpcpp/create_channel.h>
#include <grpcpp/impl/service_type.h>
#include <grpcpp/security/credentials.h>
#include <grpcpp/security/server_credentials.h>
#include <grpcpp/server.h>
#include <grpcpp/server_builder.h>
#include <grpcpp/server_context.h>
#include <grpcpp/support/channel_arguments.h>
#include <grpcpp/support/status.h>
#include <grpcpp/support/string_ref.h>
#include <grpcpp/support/sync_stream.h>
