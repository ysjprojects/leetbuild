// grpc::StatusCode, gRPC's status codes.
#pragma once

namespace grpc {

enum StatusCode {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
  DO_NOT_USE = -1,
};

// The code's name ("DEADLINE_EXCEEDED"): how the harness shows a StatusCode (found by ADL).
const char* EnumName(StatusCode code);

}  // namespace grpc
