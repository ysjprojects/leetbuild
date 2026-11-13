// Deadlines as the runtime's virtual time: milliseconds since the epoch (infinity: none). As in
// grpc++, a deadline is a std::chrono::system_clock::time_point: grpc::TimePoint<T> has no
// specialization for another clock, so a steady_clock deadline does not compile.
#pragma once

#include <chrono>
#include <limits>

namespace grpc::internal {

template <class T>
inline constexpr bool kSystemTimePoint = false;
template <class D>
inline constexpr bool kSystemTimePoint<std::chrono::time_point<std::chrono::system_clock, D>> = true;

template <class T>
double to_ms(const T& t) {
  static_assert(kSystemTimePoint<T>,
                "grpc::TimePoint<T> has no specialization for this type: a gRPC deadline is a "
                "std::chrono::system_clock::time_point (std::chrono::system_clock::now() + timeout); "
                "steady_clock and other clocks do not convert");
  if (t == T::max()) return std::numeric_limits<double>::infinity();
  return std::chrono::duration<double, std::milli>(t.time_since_epoch()).count();
}

std::chrono::system_clock::time_point from_ms(double ms);

}  // namespace grpc::internal
