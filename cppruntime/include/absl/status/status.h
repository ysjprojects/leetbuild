// Abseil's absl::Status, as far as the runtime's libraries return it (protobuf's JSON functions):
// a code and a message. Implemented in cppruntime/src/absl.cpp.
#pragma once

#include <iosfwd>
#include <string>
#include <string_view>

namespace absl {

enum class StatusCode : int {
  kOk = 0,
  kCancelled = 1,
  kUnknown = 2,
  kInvalidArgument = 3,
  kDeadlineExceeded = 4,
  kNotFound = 5,
  kAlreadyExists = 6,
  kPermissionDenied = 7,
  kResourceExhausted = 8,
  kFailedPrecondition = 9,
  kAborted = 10,
  kOutOfRange = 11,
  kUnimplemented = 12,
  kInternal = 13,
  kUnavailable = 14,
  kDataLoss = 15,
  kUnauthenticated = 16,
};

std::string StatusCodeToString(StatusCode code);

class Status {
 public:
  Status() = default;
  Status(StatusCode code, std::string_view message) : code_(code), message_(code == StatusCode::kOk ? "" : message) {}
  bool ok() const { return code_ == StatusCode::kOk; }
  StatusCode code() const { return code_; }
  int raw_code() const { return static_cast<int>(code_); }
  std::string_view message() const { return message_; }
  std::string ToString() const;
  void IgnoreError() const {}
  friend bool operator==(const Status& a, const Status& b) { return a.code_ == b.code_ && a.message_ == b.message_; }

 private:
  StatusCode code_ = StatusCode::kOk;
  std::string message_;
};

std::ostream& operator<<(std::ostream& out, const Status& status);

inline Status OkStatus() { return Status(); }
inline Status InvalidArgumentError(std::string_view m) { return Status(StatusCode::kInvalidArgument, m); }
inline Status NotFoundError(std::string_view m) { return Status(StatusCode::kNotFound, m); }
inline Status InternalError(std::string_view m) { return Status(StatusCode::kInternal, m); }
inline Status UnknownError(std::string_view m) { return Status(StatusCode::kUnknown, m); }
inline Status UnavailableError(std::string_view m) { return Status(StatusCode::kUnavailable, m); }

}  // namespace absl
