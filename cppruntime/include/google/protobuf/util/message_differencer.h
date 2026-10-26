// protobuf's MessageDifferencer, as far as comparing two messages for equality goes.
#pragma once

#include <google/protobuf/message.h>

namespace google::protobuf::util {

class MessageDifferencer {
 public:
  // Same type, same field values (a field at its default equals one never set, as in proto3).
  static bool Equals(const Message& a, const Message& b);
  static bool Equivalent(const Message& a, const Message& b) { return Equals(a, b); }
};

}  // namespace google::protobuf::util
