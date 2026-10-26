// grpc::Status: a call's outcome, a code and a message (and binary details).
#pragma once

#include <string>
#include <utility>

#include <grpcpp/support/status_code_enum.h>

namespace grpc {

using std::string;

class Status {
 public:
  Status() = default;
  Status(StatusCode code, std::string error_message) : code_(code), error_message_(std::move(error_message)) {}
  Status(StatusCode code, std::string error_message, std::string error_details)
      : code_(code), error_message_(std::move(error_message)), binary_error_details_(std::move(error_details)) {}

  static const Status& OK;
  static const Status& CANCELLED;

  StatusCode error_code() const { return code_; }
  std::string error_message() const { return error_message_; }
  std::string error_details() const { return binary_error_details_; }
  bool ok() const { return code_ == StatusCode::OK; }
  void IgnoreError() const {}

 private:
  StatusCode code_ = StatusCode::OK;
  std::string error_message_;
  std::string binary_error_details_;
};

}  // namespace grpc
