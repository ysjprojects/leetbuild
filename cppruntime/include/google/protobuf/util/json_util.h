// protobuf's JSON conversion (proto3's JSON mapping): field names in lowerCamelCase (or as in the
// .proto with preserve_proto_field_names), 64-bit integers as strings, bytes in base64, enums by
// name, fields at their default left out unless asked for. Implemented in cppruntime/src/protobuf.cpp.
#pragma once

#include <string>
#include <string_view>

#include <absl/status/status.h>
#include <google/protobuf/message.h>

namespace google::protobuf::util {

using Status = absl::Status;

struct JsonPrintOptions {
  bool add_whitespace = false;
  bool always_print_primitive_fields = false;
  bool always_print_fields_with_no_presence = false;
  bool always_print_enums_as_ints = false;
  bool preserve_proto_field_names = false;
  bool unquote_int64_if_possible = false;
};
using JsonOptions = JsonPrintOptions;

struct JsonParseOptions {
  bool ignore_unknown_fields = false;
  bool case_insensitive_enum_parsing = false;
};

absl::Status MessageToJsonString(const Message& message, std::string* output, const JsonPrintOptions& options);
absl::Status MessageToJsonString(const Message& message, std::string* output);
absl::Status JsonStringToMessage(std::string_view input, Message* message, const JsonParseOptions& options);
absl::Status JsonStringToMessage(std::string_view input, Message* message);

}  // namespace google::protobuf::util
