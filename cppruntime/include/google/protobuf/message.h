// protobuf's C++ runtime, as the runtime models it: the base class of the messages protoc-style
// code generates (src/lib/runtime/cpp/protogen.ts writes <name>.pb.h from a course's .proto files)
// and the descriptor tables that code carries. Each generated class keeps its fields as plain
// members with protoc's accessors; serialization (the wire format), Clear/CopyFrom/MergeFrom,
// DebugString and JSON (util/json_util.h) are generic, driven by the class's table, and compiled
// once in cppruntime/src/protobuf.cpp.
#pragma once

#include <cstdint>
#include <iosfwd>
#include <string>
#include <string_view>
#include <utility>

#include <google/protobuf/map.h>
#include <google/protobuf/repeated_field.h>

namespace google::protobuf {

class MessageLite;
class Message;

namespace internal {

// A field's type, as in descriptor.proto.
enum class Type : uint8_t {
  kDouble, kFloat, kInt64, kUInt64, kInt32, kFixed64, kFixed32, kBool, kString, kMessage, kBytes,
  kUInt32, kEnum, kSFixed32, kSFixed64, kSInt32, kSInt64,
};
enum class Label : uint8_t { kSingular, kRepeated, kMap };

struct EnumValue {
  int number;
  const char* name;
};
struct EnumInfo {
  const char* full_name;
  const EnumValue* values;
  int count;
};

struct MessageInfo;

// One field of a generated message: `at` is where its storage is in a message of the class (the
// value; a RepeatedField<T>; a RepeatedPtrFieldBase; a MapBase; a MessageSlot for a message).
// A map field's `type` is its value's, `key` its key's.
struct FieldInfo {
  int number;
  const char* name;
  const char* json_name;
  Type type;
  Label label;
  int oneof;  // index into the class's oneofs (proto3 `optional` is a oneof of one), -1: none
  void* (*at)(MessageLite*);
  const MessageInfo& (*message)() = nullptr;
  const EnumInfo& (*enumeration)() = nullptr;
  Type key = Type::kInt32;
};

struct MessageInfo {
  const char* full_name;
  const FieldInfo* fields;
  int field_count;
  MessageLite* (*make)();
  int* (*cases)(MessageLite*) = nullptr;  // the oneof cases (the set field's number, 0: none)
  int oneof_count = 0;
};

// A singular message field: the message, once set (owned).
struct MessageSlot {
  MessageLite* p = nullptr;
  MessageSlot() = default;
  MessageSlot(const MessageSlot&) = delete;
  MessageSlot& operator=(const MessageSlot&) = delete;
  MessageSlot(MessageSlot&& o) noexcept : p(o.p) { o.p = nullptr; }
  MessageSlot& operator=(MessageSlot&& o) noexcept {
    std::swap(p, o.p);
    return *this;
  }
  ~MessageSlot();
  void reset();
};

const std::string& empty_string();

// The untyped storage of a field, for its FieldInfo.
template <class T>
void* erase(T* p) {
  return p;
}
template <class T>
void* erase(RepeatedPtrField<T>* p) {
  return static_cast<RepeatedPtrFieldBase*>(p);
}
template <class K, class V>
void* erase(Map<K, V>* p) {
  return static_cast<MapBase*>(p);
}

// A singular message field's accessors.
template <class T>
const T& get(const MessageSlot& s) {
  return s.p != nullptr ? *static_cast<const T*>(s.p) : T::default_instance();
}
template <class T>
T* mut(MessageSlot& s) {
  if (s.p == nullptr) s.p = new T();
  return static_cast<T*>(s.p);
}
template <class T>
T* release(MessageSlot& s) {
  T* out = static_cast<T*>(s.p);  // nullptr when the field is not set
  s.p = nullptr;
  return out;
}
template <class T>
void set_allocated(MessageSlot& s, T* v) {
  s.reset();
  s.p = v;
}

bool enum_valid(const EnumInfo& e, int value);
const std::string& enum_name(const EnumInfo& e, int value);
bool enum_parse(const EnumInfo& e, std::string_view name, int* value);

}  // namespace internal

class MessageLite {
 public:
  virtual ~MessageLite() = default;

  // The generated class's table, and a new empty message of its class.
  virtual const internal::MessageInfo& lb_info() const = 0;
  virtual MessageLite* New() const = 0;

  std::string GetTypeName() const;
  void Clear();
  bool IsInitialized() const { return true; }

  std::string SerializeAsString() const;
  std::string SerializePartialAsString() const { return SerializeAsString(); }
  bool SerializeToString(std::string* out) const;
  bool SerializePartialToString(std::string* out) const { return SerializeToString(out); }
  bool AppendToString(std::string* out) const;
  bool SerializeToArray(void* data, int size) const;
  bool SerializeToOstream(std::ostream* out) const;
  size_t ByteSizeLong() const;
  int ByteSize() const { return static_cast<int>(ByteSizeLong()); }

  bool ParseFromString(std::string_view data);
  bool ParsePartialFromString(std::string_view data) { return ParseFromString(data); }
  bool ParseFromArray(const void* data, int size);
  bool ParseFromIstream(std::istream* in);
  bool MergeFromString(std::string_view data);

  std::string DebugString() const;
  std::string ShortDebugString() const;
  std::string Utf8DebugString() const { return DebugString(); }

 protected:
  MessageLite() = default;
  MessageLite(const MessageLite&) = default;
  MessageLite(MessageLite&&) noexcept = default;
  MessageLite& operator=(const MessageLite&) = default;
  MessageLite& operator=(MessageLite&&) noexcept = default;
};

class Message : public MessageLite {
 public:
  void CopyFrom(const Message& from);
  void MergeFrom(const Message& from);
  void Swap(Message* other);

 protected:
  Message() = default;
  Message(const Message&) = default;
  Message(Message&&) noexcept = default;
  Message& operator=(const Message&) = default;
  Message& operator=(Message&&) noexcept = default;
};

}  // namespace google::protobuf
