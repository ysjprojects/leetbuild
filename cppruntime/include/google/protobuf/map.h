// protobuf's map fields for the runtime's protobuf model: Map<K, V> is a std::map (iteration in
// key order, where protobuf's own order is unspecified) with protobuf's API, plus an untyped view
// the model's serializer, JSON and text printers use.
#pragma once

#include <cstddef>
#include <map>
#include <type_traits>

namespace google::protobuf {

class MessageLite;

namespace internal {

class MapBase {
 public:
  virtual ~MapBase() = default;
  virtual void lb_clear() = 0;
  virtual size_t lb_size() const = 0;
  // fn(ctx, key, value) for every entry, in key order: key points at the K, value at the V (a
  // MessageLite for message values).
  virtual void lb_each(void (*fn)(void* ctx, const void* key, const void* value), void* ctx) const = 0;
  // The value at key (a K), inserted when missing.
  virtual void* lb_at(const void* key) = 0;

 protected:
  MapBase() = default;
  MapBase(const MapBase&) = default;
  MapBase& operator=(const MapBase&) = default;
};

}  // namespace internal

template <class K, class V>
class Map : public std::map<K, V>, public internal::MapBase {
  static const void* up(const V* v) {
    if constexpr (std::is_base_of_v<MessageLite, V>) return static_cast<const MessageLite*>(v);
    else return v;
  }

 public:
  using std::map<K, V>::map;
  Map() = default;
  Map(const Map&) = default;
  Map(Map&&) noexcept = default;
  Map& operator=(const Map&) = default;
  Map& operator=(Map&&) noexcept = default;

  void lb_clear() override { this->clear(); }
  size_t lb_size() const override { return this->size(); }
  void lb_each(void (*fn)(void*, const void*, const void*), void* ctx) const override {
    for (const auto& [k, v] : *this) fn(ctx, &k, up(&v));
  }
  void* lb_at(const void* key) override { return const_cast<void*>(up(&(*this)[*static_cast<const K*>(key)])); }
};

}  // namespace google::protobuf
