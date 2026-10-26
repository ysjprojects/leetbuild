// The protobuf model's compiled half (cppruntime/include/google/protobuf): the wire format, Clear /
// CopyFrom / MergeFrom, DebugString, proto3 JSON and MessageDifferencer, all driven by the field
// tables of the generated classes (src/lib/runtime/cpp/protogen.ts).
#include <google/protobuf/message.h>
#include <google/protobuf/util/json_util.h>
#include <google/protobuf/util/message_differencer.h>

#include <absl/strings/escaping.h>
#include <nlohmann/json.hpp>

#include <charconv>
#include <cmath>
#include <cstring>
#include <functional>
#include <istream>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <ostream>

namespace google::protobuf {

namespace internal {

MessageSlot::~MessageSlot() { delete p; }

void MessageSlot::reset() {
  delete p;
  p = nullptr;
}

const std::string& empty_string() {
  static const std::string empty;
  return empty;
}

bool enum_valid(const EnumInfo& e, int value) {
  for (int i = 0; i < e.count; ++i) {
    if (e.values[i].number == value) return true;
  }
  return false;
}

const std::string& enum_name(const EnumInfo& e, int value) {
  static std::map<std::pair<const EnumInfo*, int>, std::string> names;
  const auto key = std::make_pair(&e, value);
  auto it = names.find(key);
  if (it != names.end()) return it->second;
  for (int i = 0; i < e.count; ++i) {
    if (e.values[i].number == value) return names.emplace(key, e.values[i].name).first->second;
  }
  return empty_string();
}

bool enum_parse(const EnumInfo& e, std::string_view name, int* value) {
  for (int i = 0; i < e.count; ++i) {
    if (name == e.values[i].name) {
      *value = e.values[i].number;
      return true;
    }
  }
  return false;
}

namespace {

// ---- typed access to untyped storage --------------------------------------------------------

#define LB_NUMERIC(X)                                                                                   \
  X(kDouble, double) X(kFloat, float) X(kInt64, int64_t) X(kUInt64, uint64_t) X(kInt32, int32_t)        \
  X(kFixed64, uint64_t) X(kFixed32, uint32_t) X(kBool, bool) X(kUInt32, uint32_t) X(kEnum, int)         \
  X(kSFixed32, int32_t) X(kSFixed64, int64_t) X(kSInt32, int32_t) X(kSInt64, int64_t)

const MessageInfo& info_of(const MessageLite& m) { return m.lb_info(); }

void* at(const MessageLite& m, const FieldInfo& f) { return f.at(const_cast<MessageLite*>(&m)); }

int* cases(const MessageLite& m) {
  const MessageInfo& info = info_of(m);
  return info.cases == nullptr ? nullptr : info.cases(const_cast<MessageLite*>(&m));
}

bool is_zero(Type t, const void* v) {
  switch (t) {
    case Type::kDouble: {
      uint64_t bits;
      std::memcpy(&bits, v, 8);
      return bits == 0;
    }
    case Type::kFloat: {
      uint32_t bits;
      std::memcpy(&bits, v, 4);
      return bits == 0;
    }
#define X(k, T) \
  case Type::k: return *static_cast<const T*>(v) == T{};
      X(kInt64, int64_t) X(kUInt64, uint64_t) X(kInt32, int32_t) X(kFixed64, uint64_t) X(kFixed32, uint32_t)
      X(kBool, bool) X(kUInt32, uint32_t) X(kEnum, int) X(kSFixed32, int32_t) X(kSFixed64, int64_t)
      X(kSInt32, int32_t) X(kSInt64, int64_t)
#undef X
    case Type::kString:
    case Type::kBytes: return static_cast<const std::string*>(v)->empty();
    case Type::kMessage: return false;
  }
  return true;
}

// Assign a scalar or string value (not a message).
void copy_value(Type t, void* dst, const void* src) {
  switch (t) {
#define X(k, T) \
  case Type::k: *static_cast<T*>(dst) = *static_cast<const T*>(src); return;
    LB_NUMERIC(X)
#undef X
    case Type::kString:
    case Type::kBytes: *static_cast<std::string*>(dst) = *static_cast<const std::string*>(src); return;
    case Type::kMessage: return;
  }
}

void set_zero(Type t, void* v) {
  switch (t) {
#define X(k, T) \
  case Type::k: *static_cast<T*>(v) = T{}; return;
    LB_NUMERIC(X)
#undef X
    case Type::kString:
    case Type::kBytes: static_cast<std::string*>(v)->clear(); return;
    case Type::kMessage: return;
  }
}

// Repeated fields: their length, element i, a new element at the end.
int rep_size(const FieldInfo& f, void* s) {
  switch (f.type) {
#define X(k, T) \
  case Type::k: return static_cast<RepeatedField<T>*>(s)->size();
    LB_NUMERIC(X)
#undef X
    default: return static_cast<RepeatedPtrFieldBase*>(s)->size();
  }
}

const void* rep_get(const FieldInfo& f, void* s, int i) {
  switch (f.type) {
#define X(k, T) \
  case Type::k: return &static_cast<RepeatedField<T>*>(s)->Get(i);
    LB_NUMERIC(X)
#undef X
    default: return static_cast<RepeatedPtrFieldBase*>(s)->raw(i);
  }
}

void* rep_add(const FieldInfo& f, void* s) {
  switch (f.type) {
#define X(k, T) \
  case Type::k: return static_cast<RepeatedField<T>*>(s)->Add();
    LB_NUMERIC(X)
#undef X
    case Type::kString:
    case Type::kBytes: {
      auto* item = new std::string();
      static_cast<RepeatedPtrFieldBase*>(s)->push_raw(item);
      return item;
    }
    case Type::kMessage: {
      MessageLite* item = f.message().make();
      static_cast<RepeatedPtrFieldBase*>(s)->push_raw(item);
      return item;
    }
  }
  return nullptr;
}

void rep_clear(const FieldInfo& f, void* s) {
  switch (f.type) {
#define X(k, T) \
  case Type::k: static_cast<RepeatedField<T>*>(s)->Clear(); return;
    LB_NUMERIC(X)
#undef X
    case Type::kString:
    case Type::kBytes: {
      auto* base = static_cast<RepeatedPtrFieldBase*>(s);
      while (!base->empty()) delete static_cast<std::string*>(base->pop_raw());
      return;
    }
    case Type::kMessage: {
      auto* base = static_cast<RepeatedPtrFieldBase*>(s);
      while (!base->empty()) delete static_cast<MessageLite*>(base->pop_raw());
      return;
    }
  }
}

// A map key of any key type.
struct Key {
  std::string s;
  int32_t i32 = 0;
  int64_t i64 = 0;
  uint32_t u32 = 0;
  uint64_t u64 = 0;
  bool b = false;
  void* ptr(Type t) {
    switch (t) {
      case Type::kString: return &s;
      case Type::kInt32:
      case Type::kSInt32:
      case Type::kSFixed32: return &i32;
      case Type::kInt64:
      case Type::kSInt64:
      case Type::kSFixed64: return &i64;
      case Type::kUInt32:
      case Type::kFixed32: return &u32;
      case Type::kUInt64:
      case Type::kFixed64: return &u64;
      case Type::kBool: return &b;
      default: return &s;
    }
  }
};

void each_entry(const FieldInfo& f, void* s, const std::function<void(const void*, const void*)>& fn) {
  static_cast<MapBase*>(s)->lb_each(
      [](void* ctx, const void* k, const void* v) {
        (*static_cast<const std::function<void(const void*, const void*)>*>(ctx))(k, v);
      },
      const_cast<void*>(static_cast<const void*>(&fn)));
}

void clear_message(MessageLite& m);
void merge_message(MessageLite& to, const MessageLite& from);

void clear_field(MessageLite& m, const FieldInfo& f) {
  void* s = at(m, f);
  if (f.label == Label::kMap) {
    static_cast<MapBase*>(s)->lb_clear();
  } else if (f.label == Label::kRepeated) {
    rep_clear(f, s);
  } else if (f.type == Type::kMessage) {
    static_cast<MessageSlot*>(s)->reset();
  } else {
    set_zero(f.type, s);
  }
}

// Make f the set member of its oneof (clearing the member set before).
void select_oneof(MessageLite& m, const FieldInfo& f) {
  if (f.oneof < 0) return;
  int* c = cases(m);
  if (c[f.oneof] == f.number) return;
  const MessageInfo& info = info_of(m);
  for (int i = 0; i < info.field_count; ++i) {
    if (info.fields[i].oneof == f.oneof) clear_field(m, info.fields[i]);
  }
  c[f.oneof] = f.number;
}

// Whether a singular field is present: a oneof member set, a message set, a scalar not at its default.
bool present(const MessageLite& m, const FieldInfo& f) {
  if (f.oneof >= 0) return cases(m)[f.oneof] == f.number;
  void* s = at(m, f);
  if (f.type == Type::kMessage) return static_cast<MessageSlot*>(s)->p != nullptr;
  return !is_zero(f.type, s);
}

MessageLite* slot_message(MessageLite& m, const FieldInfo& f) {
  auto* slot = static_cast<MessageSlot*>(at(m, f));
  if (slot->p == nullptr) slot->p = f.message().make();
  return slot->p;
}

void clear_message(MessageLite& m) {
  const MessageInfo& info = info_of(m);
  for (int i = 0; i < info.field_count; ++i) clear_field(m, info.fields[i]);
  if (info.cases != nullptr) {
    int* c = info.cases(&m);
    for (int i = 0; i < info.oneof_count; ++i) c[i] = 0;
  }
}

void merge_message(MessageLite& to, const MessageLite& from) {
  const MessageInfo& info = info_of(from);
  for (int i = 0; i < info.field_count; ++i) {
    const FieldInfo& f = info.fields[i];
    void* src = at(from, f);
    if (f.label == Label::kMap) {
      auto* dst = static_cast<MapBase*>(at(to, f));
      Key key;
      each_entry(f, src, [&](const void* k, const void* v) {
        copy_value(f.key, key.ptr(f.key), k);
        void* value = dst->lb_at(key.ptr(f.key));
        if (f.type == Type::kMessage) {
          clear_message(*static_cast<MessageLite*>(value));
          merge_message(*static_cast<MessageLite*>(value), *static_cast<const MessageLite*>(v));
        } else {
          copy_value(f.type, value, v);
        }
      });
    } else if (f.label == Label::kRepeated) {
      void* dst = at(to, f);
      const int n = rep_size(f, src);
      for (int j = 0; j < n; ++j) {
        const void* item = rep_get(f, src, j);
        void* added = rep_add(f, dst);
        if (f.type == Type::kMessage) {
          merge_message(*static_cast<MessageLite*>(added), *static_cast<const MessageLite*>(item));
        } else {
          copy_value(f.type, added, item);
        }
      }
    } else if (present(from, f)) {
      select_oneof(to, f);
      if (f.type == Type::kMessage) {
        merge_message(*slot_message(to, f), *static_cast<MessageSlot*>(src)->p);
      } else {
        copy_value(f.type, at(to, f), src);
      }
    }
  }
}

// ---- the wire format ------------------------------------------------------------------------

enum Wire { kVarint = 0, kFixed64 = 1, kLength = 2, kFixed32 = 5 };

int wire_of(Type t) {
  switch (t) {
    case Type::kDouble:
    case Type::kFixed64:
    case Type::kSFixed64: return kFixed64;
    case Type::kFloat:
    case Type::kFixed32:
    case Type::kSFixed32: return kFixed32;
    case Type::kString:
    case Type::kBytes:
    case Type::kMessage: return kLength;
    default: return kVarint;
  }
}

void put_varint(std::string& out, uint64_t v) {
  while (v >= 0x80) {
    out += static_cast<char>((v & 0x7f) | 0x80);
    v >>= 7;
  }
  out += static_cast<char>(v);
}

void put_fixed(std::string& out, const void* v, int bytes) { out.append(static_cast<const char*>(v), static_cast<size_t>(bytes)); }

void put_tag(std::string& out, int number, int wire) { put_varint(out, (static_cast<uint64_t>(number) << 3) | static_cast<uint64_t>(wire)); }

void serialize(const MessageLite& m, std::string& out);

// One value without its tag (a message or string with its length).
void put_value(std::string& out, Type t, const void* v) {
  switch (t) {
    case Type::kDouble: put_fixed(out, v, 8); return;
    case Type::kFloat: put_fixed(out, v, 4); return;
    case Type::kInt64: put_varint(out, static_cast<uint64_t>(*static_cast<const int64_t*>(v))); return;
    case Type::kUInt64: put_varint(out, *static_cast<const uint64_t*>(v)); return;
    case Type::kInt32: put_varint(out, static_cast<uint64_t>(static_cast<int64_t>(*static_cast<const int32_t*>(v)))); return;
    case Type::kEnum: put_varint(out, static_cast<uint64_t>(static_cast<int64_t>(*static_cast<const int*>(v)))); return;
    case Type::kFixed64:
    case Type::kSFixed64: put_fixed(out, v, 8); return;
    case Type::kFixed32:
    case Type::kSFixed32: put_fixed(out, v, 4); return;
    case Type::kBool: put_varint(out, *static_cast<const bool*>(v) ? 1 : 0); return;
    case Type::kUInt32: put_varint(out, *static_cast<const uint32_t*>(v)); return;
    case Type::kSInt32: {
      const int32_t n = *static_cast<const int32_t*>(v);
      put_varint(out, (static_cast<uint32_t>(n) << 1) ^ static_cast<uint32_t>(n >> 31));
      return;
    }
    case Type::kSInt64: {
      const int64_t n = *static_cast<const int64_t*>(v);
      put_varint(out, (static_cast<uint64_t>(n) << 1) ^ static_cast<uint64_t>(n >> 63));
      return;
    }
    case Type::kString:
    case Type::kBytes: {
      const auto* s = static_cast<const std::string*>(v);
      put_varint(out, s->size());
      out += *s;
      return;
    }
    case Type::kMessage: {
      std::string body;
      serialize(*static_cast<const MessageLite*>(v), body);
      put_varint(out, body.size());
      out += body;
      return;
    }
  }
}

void serialize(const MessageLite& m, std::string& out) {
  const MessageInfo& info = info_of(m);
  for (int i = 0; i < info.field_count; ++i) {
    const FieldInfo& f = info.fields[i];
    void* s = at(m, f);
    if (f.label == Label::kMap) {
      Key zero;
      each_entry(f, s, [&](const void* k, const void* v) {
        std::string entry;
        put_tag(entry, 1, wire_of(f.key));
        put_value(entry, f.key, k);
        put_tag(entry, 2, wire_of(f.type));
        put_value(entry, f.type, v);
        put_tag(out, f.number, kLength);
        put_varint(out, entry.size());
        out += entry;
      });
    } else if (f.label == Label::kRepeated) {
      const int n = rep_size(f, s);
      if (n == 0) continue;
      if (wire_of(f.type) != kLength) {  // packed
        std::string packed;
        for (int j = 0; j < n; ++j) put_value(packed, f.type, rep_get(f, s, j));
        put_tag(out, f.number, kLength);
        put_varint(out, packed.size());
        out += packed;
      } else {
        for (int j = 0; j < n; ++j) {
          put_tag(out, f.number, kLength);
          put_value(out, f.type, rep_get(f, s, j));
        }
      }
    } else if (present(m, f)) {
      put_tag(out, f.number, wire_of(f.type));
      put_value(out, f.type, f.type == Type::kMessage ? static_cast<const void*>(static_cast<MessageSlot*>(s)->p) : s);
    }
  }
}

struct Reader {
  const unsigned char* p;
  const unsigned char* end;

  bool varint(uint64_t* v) {
    uint64_t result = 0;
    for (int shift = 0; shift < 64; shift += 7) {
      if (p >= end) return false;
      const unsigned char b = *p++;
      result |= static_cast<uint64_t>(b & 0x7f) << shift;
      if ((b & 0x80) == 0) {
        *v = result;
        return true;
      }
    }
    return false;
  }
  bool fixed(void* v, int bytes) {
    if (end - p < bytes) return false;
    std::memcpy(v, p, static_cast<size_t>(bytes));
    p += bytes;
    return true;
  }
  bool bytes(std::string_view* v) {
    uint64_t n;
    if (!varint(&n) || n > static_cast<uint64_t>(end - p)) return false;
    *v = std::string_view(reinterpret_cast<const char*>(p), static_cast<size_t>(n));
    p += n;
    return true;
  }
  bool skip(int wire) {
    uint64_t n;
    std::string_view s;
    char buf[8];
    switch (wire) {
      case kVarint: return varint(&n);
      case kFixed64: return fixed(buf, 8);
      case kFixed32: return fixed(buf, 4);
      case kLength: return bytes(&s);
      default: return false;
    }
  }
};

bool parse(MessageLite& m, std::string_view data);

// Read one value of type t (sent with wire type wire) into v.
bool get_value(Reader& r, Type t, int wire, void* v) {
  if (wire != wire_of(t)) return false;
  uint64_t n = 0;
  switch (t) {
    case Type::kDouble:
    case Type::kFixed64:
    case Type::kSFixed64: return r.fixed(v, 8);
    case Type::kFloat:
    case Type::kFixed32:
    case Type::kSFixed32: return r.fixed(v, 4);
    case Type::kString:
    case Type::kBytes: {
      std::string_view s;
      if (!r.bytes(&s)) return false;
      static_cast<std::string*>(v)->assign(s);
      return true;
    }
    case Type::kMessage: {
      std::string_view s;
      return r.bytes(&s) && parse(*static_cast<MessageLite*>(v), s);
    }
    default: break;
  }
  if (!r.varint(&n)) return false;
  switch (t) {
    case Type::kInt64: *static_cast<int64_t*>(v) = static_cast<int64_t>(n); break;
    case Type::kUInt64: *static_cast<uint64_t*>(v) = n; break;
    case Type::kInt32: *static_cast<int32_t*>(v) = static_cast<int32_t>(n); break;
    case Type::kEnum: *static_cast<int*>(v) = static_cast<int>(n); break;
    case Type::kBool: *static_cast<bool*>(v) = n != 0; break;
    case Type::kUInt32: *static_cast<uint32_t*>(v) = static_cast<uint32_t>(n); break;
    case Type::kSInt32: *static_cast<int32_t*>(v) = static_cast<int32_t>((static_cast<uint32_t>(n) >> 1) ^ (0u - static_cast<uint32_t>(n & 1))); break;
    case Type::kSInt64: *static_cast<int64_t*>(v) = static_cast<int64_t>((n >> 1) ^ (0ull - (n & 1))); break;
    default: return false;
  }
  return true;
}

bool parse_entry(const FieldInfo& f, MapBase& map, std::string_view data) {
  Reader r{reinterpret_cast<const unsigned char*>(data.data()), reinterpret_cast<const unsigned char*>(data.data() + data.size())};
  Key key;
  std::string_view value;
  bool has_value = false;
  int value_wire = wire_of(f.type);
  while (r.p < r.end) {
    uint64_t tag;
    if (!r.varint(&tag)) return false;
    const int number = static_cast<int>(tag >> 3);
    const int wire = static_cast<int>(tag & 7);
    if (number == 1) {
      if (!get_value(r, f.key, wire, key.ptr(f.key))) return false;
    } else if (number == 2) {
      const unsigned char* start = r.p;
      if (!r.skip(wire)) return false;
      value = std::string_view(reinterpret_cast<const char*>(start), static_cast<size_t>(r.p - start));
      value_wire = wire;
      has_value = true;
    } else if (!r.skip(wire)) {
      return false;
    }
  }
  void* slot = map.lb_at(key.ptr(f.key));
  if (f.type == Type::kMessage) {
    clear_message(*static_cast<MessageLite*>(slot));
  } else {
    set_zero(f.type, slot);
  }
  if (!has_value) return true;
  Reader vr{reinterpret_cast<const unsigned char*>(value.data()), reinterpret_cast<const unsigned char*>(value.data() + value.size())};
  return get_value(vr, f.type, value_wire, slot);
}

const FieldInfo* field_number(const MessageInfo& info, int number) {
  for (int i = 0; i < info.field_count; ++i) {
    if (info.fields[i].number == number) return &info.fields[i];
  }
  return nullptr;
}

// Merge the encoded data into m.
bool parse(MessageLite& m, std::string_view data) {
  const MessageInfo& info = info_of(m);
  Reader r{reinterpret_cast<const unsigned char*>(data.data()), reinterpret_cast<const unsigned char*>(data.data() + data.size())};
  while (r.p < r.end) {
    uint64_t tag;
    if (!r.varint(&tag)) return false;
    const int number = static_cast<int>(tag >> 3);
    const int wire = static_cast<int>(tag & 7);
    if (number <= 0) return false;
    const FieldInfo* f = field_number(info, number);
    if (f == nullptr) {
      if (!r.skip(wire)) return false;
      continue;
    }
    void* s = at(m, *f);
    if (f->label == Label::kMap) {
      std::string_view entry;
      if (wire != kLength || !r.bytes(&entry) || !parse_entry(*f, *static_cast<MapBase*>(s), entry)) return false;
    } else if (f->label == Label::kRepeated) {
      if (wire == kLength && wire_of(f->type) != kLength) {  // packed
        std::string_view packed;
        if (!r.bytes(&packed)) return false;
        Reader pr{reinterpret_cast<const unsigned char*>(packed.data()), reinterpret_cast<const unsigned char*>(packed.data() + packed.size())};
        while (pr.p < pr.end) {
          if (!get_value(pr, f->type, wire_of(f->type), rep_add(*f, s))) return false;
        }
      } else if (!get_value(r, f->type, wire, rep_add(*f, s))) {
        return false;
      }
    } else {
      select_oneof(m, *f);
      if (!get_value(r, f->type, wire, f->type == Type::kMessage ? slot_message(m, *f) : s)) return false;
    }
  }
  return true;
}

// ---- text format (DebugString) ------------------------------------------------------------

std::string shortest(double v, bool single) {
  if (std::isnan(v)) return "nan";
  if (std::isinf(v)) return v > 0 ? "inf" : "-inf";
  char buf[64];
  const auto res = single ? std::to_chars(buf, buf + sizeof buf, static_cast<float>(v)) : std::to_chars(buf, buf + sizeof buf, v);
  return std::string(buf, res.ptr);
}

std::string c_escape(const std::string& s) {
  std::string out;
  for (unsigned char c : s) {
    switch (c) {
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '"': out += "\\\""; break;
      case '\'': out += "\\'"; break;
      case '\\': out += "\\\\"; break;
      default:
        if (c < 0x20 || c >= 0x7f) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\%03o", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

std::string text_scalar(Type t, const void* v, const EnumInfo* e) {
  switch (t) {
    case Type::kDouble: return shortest(*static_cast<const double*>(v), false);
    case Type::kFloat: return shortest(*static_cast<const float*>(v), true);
    case Type::kInt64:
    case Type::kSInt64:
    case Type::kSFixed64: return std::to_string(*static_cast<const int64_t*>(v));
    case Type::kUInt64:
    case Type::kFixed64: return std::to_string(*static_cast<const uint64_t*>(v));
    case Type::kInt32:
    case Type::kSInt32:
    case Type::kSFixed32: return std::to_string(*static_cast<const int32_t*>(v));
    case Type::kUInt32:
    case Type::kFixed32: return std::to_string(*static_cast<const uint32_t*>(v));
    case Type::kBool: return *static_cast<const bool*>(v) ? "true" : "false";
    case Type::kEnum: {
      const int n = *static_cast<const int*>(v);
      const std::string& name = e == nullptr ? empty_string() : enum_name(*e, n);
      return name.empty() ? std::to_string(n) : name;
    }
    case Type::kString:
    case Type::kBytes: return "\"" + c_escape(*static_cast<const std::string*>(v)) + "\"";
    case Type::kMessage: return "";
  }
  return "";
}

void text(const MessageLite& m, std::string& out, int depth, bool single);

void text_field(std::string& out, const std::string& name, Type t, const void* v, const EnumInfo* e, int depth, bool single) {
  if (!single) out.append(static_cast<size_t>(depth) * 2, ' ');
  out += name;
  if (t == Type::kMessage) {
    out += single ? " { " : " {\n";
    text(*static_cast<const MessageLite*>(v), out, depth + 1, single);
    if (!single) out.append(static_cast<size_t>(depth) * 2, ' ');
    out += single ? "} " : "}\n";
  } else {
    out += ": ";
    out += text_scalar(t, v, e);
    out += single ? " " : "\n";
  }
}

void text(const MessageLite& m, std::string& out, int depth, bool single) {
  const MessageInfo& info = info_of(m);
  for (int i = 0; i < info.field_count; ++i) {
    const FieldInfo& f = info.fields[i];
    const EnumInfo* e = f.enumeration == nullptr ? nullptr : &f.enumeration();
    void* s = at(m, f);
    if (f.label == Label::kMap) {
      each_entry(f, s, [&](const void* k, const void* v) {
        if (!single) out.append(static_cast<size_t>(depth) * 2, ' ');
        out += f.name;
        out += single ? " { " : " {\n";
        text_field(out, "key", f.key, k, nullptr, depth + 1, single);
        text_field(out, "value", f.type, v, e, depth + 1, single);
        if (!single) out.append(static_cast<size_t>(depth) * 2, ' ');
        out += single ? "} " : "}\n";
      });
    } else if (f.label == Label::kRepeated) {
      const int n = rep_size(f, s);
      for (int j = 0; j < n; ++j) text_field(out, f.name, f.type, rep_get(f, s, j), e, depth, single);
    } else if (present(m, f)) {
      text_field(out, f.name, f.type, f.type == Type::kMessage ? static_cast<const void*>(static_cast<MessageSlot*>(s)->p) : s, e, depth, single);
    }
  }
}

// ---- JSON ---------------------------------------------------------------------------------

std::string json_quote(const std::string& s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out + "\"";
}

struct JsonWriter {
  const util::JsonPrintOptions& options;
  std::string out;

  void newline(int depth) {
    if (!options.add_whitespace) return;
    out += '\n';
    out.append(static_cast<size_t>(depth), ' ');
  }

  void number(double v, bool single) {
    if (std::isnan(v)) out += "\"NaN\"";
    else if (std::isinf(v)) out += v > 0 ? "\"Infinity\"" : "\"-Infinity\"";
    else out += shortest(v, single);
  }

  void value(Type t, const void* v, const EnumInfo* e, int depth) {
    switch (t) {
      case Type::kDouble: number(*static_cast<const double*>(v), false); return;
      case Type::kFloat: number(*static_cast<const float*>(v), true); return;
      case Type::kInt64:
      case Type::kSInt64:
      case Type::kSFixed64: {
        const std::string n = std::to_string(*static_cast<const int64_t*>(v));
        out += options.unquote_int64_if_possible ? n : "\"" + n + "\"";
        return;
      }
      case Type::kUInt64:
      case Type::kFixed64: {
        const std::string n = std::to_string(*static_cast<const uint64_t*>(v));
        out += options.unquote_int64_if_possible ? n : "\"" + n + "\"";
        return;
      }
      case Type::kEnum: {
        const int n = *static_cast<const int*>(v);
        const std::string& name = e == nullptr || options.always_print_enums_as_ints ? empty_string() : enum_name(*e, n);
        out += name.empty() ? std::to_string(n) : json_quote(name);
        return;
      }
      case Type::kString: out += json_quote(*static_cast<const std::string*>(v)); return;
      case Type::kBytes: out += json_quote(absl::Base64Escape(*static_cast<const std::string*>(v))); return;
      case Type::kMessage: message(*static_cast<const MessageLite*>(v), depth); return;
      default: out += text_scalar(t, v, e); return;
    }
  }

  void message(const MessageLite& m, int depth) {
    const MessageInfo& info = info_of(m);
    const bool all = options.always_print_primitive_fields || options.always_print_fields_with_no_presence;
    out += '{';
    bool first = true;
    auto name = [&](const FieldInfo& f) {
      if (!first) out += ',';
      first = false;
      newline(depth + 1);
      out += json_quote(options.preserve_proto_field_names ? f.name : f.json_name);
      out += options.add_whitespace ? ": " : ":";
    };
    for (int i = 0; i < info.field_count; ++i) {
      const FieldInfo& f = info.fields[i];
      const EnumInfo* e = f.enumeration == nullptr ? nullptr : &f.enumeration();
      void* s = at(m, f);
      if (f.label == Label::kMap) {
        if (static_cast<MapBase*>(s)->lb_size() == 0 && !all) continue;
        name(f);
        out += '{';
        bool first_entry = true;
        each_entry(f, s, [&](const void* k, const void* v) {
          if (!first_entry) out += ',';
          first_entry = false;
          newline(depth + 2);
          out += json_quote(f.key == Type::kString ? *static_cast<const std::string*>(k) : text_scalar(f.key, k, nullptr));
          out += options.add_whitespace ? ": " : ":";
          value(f.type, v, e, depth + 2);
        });
        if (!first_entry) newline(depth + 1);
        out += '}';
      } else if (f.label == Label::kRepeated) {
        const int n = rep_size(f, s);
        if (n == 0 && !all) continue;
        name(f);
        out += '[';
        for (int j = 0; j < n; ++j) {
          if (j > 0) out += options.add_whitespace ? ", " : ",";
          value(f.type, rep_get(f, s, j), e, depth + 1);
        }
        out += ']';
      } else if (present(m, f) || (all && f.oneof < 0 && f.type != Type::kMessage)) {
        name(f);
        value(f.type, f.type == Type::kMessage ? static_cast<const void*>(static_cast<MessageSlot*>(s)->p) : s, e, depth + 1);
      }
    }
    if (!first) newline(depth);
    out += '}';
  }
};

using nlohmann::json;

struct JsonReader {
  const util::JsonParseOptions& options;
  std::string error;

  bool fail(std::string message) {
    if (error.empty()) error = std::move(message);
    return false;
  }

  template <class T>
  bool integer(const json& j, T* v, const char* field) {
    if (j.is_number_integer()) {
      if (j.is_number_unsigned()) {
        const auto n = j.get<uint64_t>();
        if (n > static_cast<uint64_t>(std::numeric_limits<T>::max())) return fail(std::string("value out of range for field ") + field);
        *v = static_cast<T>(n);
      } else {
        const auto n = j.get<int64_t>();
        if (n < static_cast<int64_t>(std::numeric_limits<T>::min()) ||
            (n > 0 && static_cast<uint64_t>(n) > static_cast<uint64_t>(std::numeric_limits<T>::max())))
          return fail(std::string("value out of range for field ") + field);
        *v = static_cast<T>(n);
      }
      return true;
    }
    if (j.is_number_float()) {
      const double d = j.get<double>();
      if (d != std::floor(d)) return fail(std::string("not an integer for field ") + field);
      *v = static_cast<T>(d);
      return true;
    }
    if (j.is_string()) {
      const std::string s = j.get<std::string>();
      T n{};
      const auto res = std::from_chars(s.data(), s.data() + s.size(), n);
      if (res.ec != std::errc() || res.ptr != s.data() + s.size()) return fail(std::string("invalid integer for field ") + field);
      *v = n;
      return true;
    }
    return fail(std::string("expected an integer for field ") + field);
  }

  template <class T>
  bool floating(const json& j, T* v, const char* field) {
    if (j.is_number()) {
      *v = static_cast<T>(j.get<double>());
      return true;
    }
    if (j.is_string()) {
      const std::string s = j.get<std::string>();
      if (s == "NaN") *v = std::numeric_limits<T>::quiet_NaN();
      else if (s == "Infinity") *v = std::numeric_limits<T>::infinity();
      else if (s == "-Infinity") *v = -std::numeric_limits<T>::infinity();
      else {
        double d = 0;
        const auto res = std::from_chars(s.data(), s.data() + s.size(), d);
        if (res.ec != std::errc() || res.ptr != s.data() + s.size()) return fail(std::string("invalid number for field ") + field);
        *v = static_cast<T>(d);
      }
      return true;
    }
    return fail(std::string("expected a number for field ") + field);
  }

  bool value(const json& j, const FieldInfo& f, Type t, void* v) {
    switch (t) {
      case Type::kDouble: return floating(j, static_cast<double*>(v), f.name);
      case Type::kFloat: return floating(j, static_cast<float*>(v), f.name);
      case Type::kInt64:
      case Type::kSInt64:
      case Type::kSFixed64: return integer(j, static_cast<int64_t*>(v), f.name);
      case Type::kUInt64:
      case Type::kFixed64: return integer(j, static_cast<uint64_t*>(v), f.name);
      case Type::kInt32:
      case Type::kSInt32:
      case Type::kSFixed32: return integer(j, static_cast<int32_t*>(v), f.name);
      case Type::kUInt32:
      case Type::kFixed32: return integer(j, static_cast<uint32_t*>(v), f.name);
      case Type::kBool:
        if (j.is_boolean()) {
          *static_cast<bool*>(v) = j.get<bool>();
          return true;
        }
        if (j.is_string() && (j == "true" || j == "false")) {
          *static_cast<bool*>(v) = j == "true";
          return true;
        }
        return fail(std::string("expected a bool for field ") + f.name);
      case Type::kEnum:
        if (j.is_string()) {
          int n = 0;
          if (f.enumeration != nullptr && enum_parse(f.enumeration(), j.get<std::string>(), &n)) {
            *static_cast<int*>(v) = n;
            return true;
          }
          if (options.ignore_unknown_fields) return true;
          return fail("invalid enum value " + j.get<std::string>() + " for field " + f.name);
        }
        return integer(j, static_cast<int*>(v), f.name);
      case Type::kString:
        if (!j.is_string()) return fail(std::string("expected a string for field ") + f.name);
        *static_cast<std::string*>(v) = j.get<std::string>();
        return true;
      case Type::kBytes: {
        if (!j.is_string()) return fail(std::string("expected base64 for field ") + f.name);
        const std::string s = j.get<std::string>();
        if (!absl::Base64Unescape(s, static_cast<std::string*>(v)) && !absl::WebSafeBase64Unescape(s, static_cast<std::string*>(v)))
          return fail(std::string("invalid base64 for field ") + f.name);
        return true;
      }
      case Type::kMessage: return message(j, *static_cast<MessageLite*>(v));
    }
    return false;
  }

  bool message(const json& j, MessageLite& m) {
    if (!j.is_object()) return fail("expected an object for " + m.GetTypeName());
    const MessageInfo& info = info_of(m);
    for (const auto& [key, item] : j.items()) {
      const FieldInfo* f = nullptr;
      for (int i = 0; i < info.field_count; ++i) {
        if (key == info.fields[i].json_name || key == info.fields[i].name) f = &info.fields[i];
      }
      if (f == nullptr) {
        if (options.ignore_unknown_fields) continue;
        return fail(m.GetTypeName() + " has no field named \"" + key + "\"");
      }
      if (item.is_null()) continue;
      void* s = at(m, *f);
      if (f->label == Label::kMap) {
        if (!item.is_object()) return fail(std::string("expected an object for map field ") + f->name);
        auto* map = static_cast<MapBase*>(s);
        for (const auto& [k, v] : item.items()) {
          Key mk;
          if (f->key == Type::kString) {
            mk.s = k;
          } else if (f->key == Type::kBool) {
            if (k != "true" && k != "false") return fail(std::string("invalid map key for field ") + f->name);
            mk.b = k == "true";
          } else if (!value(json(k), *f, f->key, mk.ptr(f->key))) {
            return false;
          }
          void* slot = map->lb_at(mk.ptr(f->key));
          if (f->type == Type::kMessage) clear_message(*static_cast<MessageLite*>(slot));
          if (!value(v, *f, f->type, slot)) return false;
        }
      } else if (f->label == Label::kRepeated) {
        if (!item.is_array()) return fail(std::string("expected an array for repeated field ") + f->name);
        for (const auto& v : item) {
          if (!value(v, *f, f->type, rep_add(*f, s))) return false;
        }
      } else {
        select_oneof(m, *f);
        if (!value(item, *f, f->type, f->type == Type::kMessage ? slot_message(m, *f) : s)) return false;
      }
    }
    return true;
  }
};

}  // namespace
}  // namespace internal

// ---- MessageLite / Message ------------------------------------------------------------------

std::string MessageLite::GetTypeName() const { return lb_info().full_name; }

void MessageLite::Clear() { internal::clear_message(*this); }

std::string MessageLite::SerializeAsString() const {
  std::string out;
  internal::serialize(*this, out);
  return out;
}

bool MessageLite::SerializeToString(std::string* out) const {
  out->clear();
  internal::serialize(*this, *out);
  return true;
}

bool MessageLite::AppendToString(std::string* out) const {
  internal::serialize(*this, *out);
  return true;
}

bool MessageLite::SerializeToArray(void* data, int size) const {
  const std::string bytes = SerializeAsString();
  if (size < 0 || bytes.size() > static_cast<size_t>(size)) return false;
  std::memcpy(data, bytes.data(), bytes.size());
  return true;
}

bool MessageLite::SerializeToOstream(std::ostream* out) const {
  const std::string bytes = SerializeAsString();
  out->write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  return out->good();
}

size_t MessageLite::ByteSizeLong() const { return SerializeAsString().size(); }

bool MessageLite::ParseFromString(std::string_view data) {
  Clear();
  return internal::parse(*this, data);
}

bool MessageLite::ParseFromArray(const void* data, int size) {
  if (size < 0) return false;
  return ParseFromString(std::string_view(static_cast<const char*>(data), static_cast<size_t>(size)));
}

bool MessageLite::ParseFromIstream(std::istream* in) {
  const std::string bytes((std::istreambuf_iterator<char>(*in)), std::istreambuf_iterator<char>());
  return ParseFromString(bytes);
}

bool MessageLite::MergeFromString(std::string_view data) { return internal::parse(*this, data); }

std::string MessageLite::DebugString() const {
  std::string out;
  internal::text(*this, out, 0, false);
  return out;
}

std::string MessageLite::ShortDebugString() const {
  std::string out;
  internal::text(*this, out, 0, true);
  if (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

void Message::CopyFrom(const Message& from) {
  if (&from == this) return;
  Clear();
  MergeFrom(from);
}

void Message::MergeFrom(const Message& from) {
  if (&from.lb_info() != &lb_info()) return;
  internal::merge_message(*this, from);
}

void Message::Swap(Message* other) {
  if (other == this) return;
  std::unique_ptr<MessageLite> held(New());
  internal::merge_message(*held, *this);
  CopyFrom(*other);
  other->Clear();
  internal::merge_message(*other, *held);
}

namespace util {

absl::Status MessageToJsonString(const Message& message, std::string* output, const JsonPrintOptions& options) {
  internal::JsonWriter w{options, {}};
  w.message(message, 0);
  *output = std::move(w.out);
  return absl::OkStatus();
}

absl::Status MessageToJsonString(const Message& message, std::string* output) {
  return MessageToJsonString(message, output, JsonPrintOptions());
}

absl::Status JsonStringToMessage(std::string_view input, Message* message, const JsonParseOptions& options) {
  const auto j = nlohmann::json::parse(input.begin(), input.end(), nullptr, false);
  if (j.is_discarded()) return absl::InvalidArgumentError("invalid JSON");
  message->Clear();
  internal::JsonReader r{options, {}};
  if (!r.message(j, *message)) return absl::InvalidArgumentError(r.error);
  return absl::OkStatus();
}

absl::Status JsonStringToMessage(std::string_view input, Message* message) {
  return JsonStringToMessage(input, message, JsonParseOptions());
}

bool MessageDifferencer::Equals(const Message& a, const Message& b) {
  return &a.lb_info() == &b.lb_info() && a.SerializeAsString() == b.SerializeAsString();
}

}  // namespace util

}  // namespace google::protobuf
