// Deadlines as the runtime's virtual time: milliseconds since the epoch (infinity: none). A
// system_clock or steady_clock time point reads the same virtual clock here.
#pragma once

#include <chrono>
#include <limits>

namespace grpc::internal {

template <class C, class D>
double to_ms(const std::chrono::time_point<C, D>& t) {
  if (t == std::chrono::time_point<C, D>::max()) return std::numeric_limits<double>::infinity();
  return std::chrono::duration<double, std::milli>(t.time_since_epoch()).count();
}

std::chrono::system_clock::time_point from_ms(double ms);

}  // namespace grpc::internal
