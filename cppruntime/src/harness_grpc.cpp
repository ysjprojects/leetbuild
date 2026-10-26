// ctx.GRPC (cppruntime/include/leetbuild/grpc.h): the harness's hooks into the gRPC model's world
// (cppruntime/src/grpc.cpp).
#include <grpcpp/grpcpp.h>
#include <leetbuild/grpc.h>

namespace harness {

grpc::Server* GRPC::Server(const std::string& target) { return grpc::lb::PeerServer(target); }
void GRPC::Stop(const std::string& target) { grpc::lb::StopPeer(target); }
void GRPC::SetLatency(const std::string& method, double seconds, const std::string& target) {
  grpc::lb::SetLatency(method, seconds, target);
}
void GRPC::Fail(const std::string& method, grpc::StatusCode code, const std::string& details, int times,
                const std::string& target) {
  grpc::lb::FailNext(method, code, details, times, target);
}
void GRPC::ClearFailures() { grpc::lb::ClearFailures(); }
std::vector<Call> GRPC::CallsTo(const std::string& method, const std::string& target) {
  return grpc::lb::CallsTo(method, target);
}
std::vector<Call> GRPC::Calls() { return grpc::lb::Calls(); }
int GRPC::LearnerCalls() { return grpc::lb::LearnerCalls(); }
bool GRPC::Serving(const std::string& method, const std::string& target) { return grpc::lb::Serving(method, target); }
std::shared_ptr<grpc::Channel> GRPC::Dial(const std::string& target) { return grpc::lb::HarnessChannel(target); }

}  // namespace harness
