// protobuf's repeated fields for the runtime's protobuf model (google/protobuf/message.h):
// RepeatedField<T> holds numbers, bools and enums by value; RepeatedPtrField<T> holds strings and
// messages, each its own object, as protobuf's does (a pointer to an element stays valid while the
// field grows). The API is protobuf's: size(), Get(i), Mutable(i), Add(), range-for, erase, ...
#pragma once

#include <compare>
#include <cstddef>
#include <initializer_list>
#include <iterator>
#include <type_traits>
#include <utility>
#include <vector>

namespace google::protobuf {

class MessageLite;

namespace internal {
// A bool element of a RepeatedField: std::vector<bool> has no addressable elements.
struct BoolSlot {
  bool v = false;
  BoolSlot() = default;
  BoolSlot(bool b) : v(b) {}
  bool operator==(const BoolSlot& o) const { return v == o.v; }
};
}  // namespace internal

template <class T>
class RepeatedField {
  using Elem = std::conditional_t<std::is_same_v<T, bool>, internal::BoolSlot, T>;
  static_assert(sizeof(Elem) == sizeof(T));

 public:
  using value_type = T;
  using size_type = int;
  using iterator = T*;
  using const_iterator = const T*;
  using reverse_iterator = std::reverse_iterator<iterator>;
  using const_reverse_iterator = std::reverse_iterator<const_iterator>;

  RepeatedField() = default;
  template <class It>
  RepeatedField(It first, It last) : v_(first, last) {}
  RepeatedField(std::initializer_list<T> items) : v_(items.begin(), items.end()) {}

  bool empty() const { return v_.empty(); }
  int size() const { return static_cast<int>(v_.size()); }
  const T& Get(int i) const { return data()[i]; }
  T* Mutable(int i) { return mutable_data() + i; }
  const T& operator[](int i) const { return data()[i]; }
  T& operator[](int i) { return mutable_data()[i]; }
  const T& at(int i) const {
    (void)v_.at(static_cast<size_t>(i));
    return data()[i];
  }
  T& at(int i) {
    (void)v_.at(static_cast<size_t>(i));
    return mutable_data()[i];
  }
  void Set(int i, const T& value) { mutable_data()[i] = value; }
  void Add(const T& value) { v_.push_back(Elem(value)); }
  T* Add() {
    v_.emplace_back();
    return mutable_data() + (v_.size() - 1);
  }
  template <class It>
  void Add(It first, It last) { v_.insert(v_.end(), first, last); }
  void RemoveLast() { v_.pop_back(); }
  void Truncate(int n) { v_.resize(static_cast<size_t>(n)); }
  void Resize(int n, const T& value) { v_.resize(static_cast<size_t>(n), Elem(value)); }
  void Reserve(int n) { v_.reserve(static_cast<size_t>(n)); }
  int Capacity() const { return static_cast<int>(v_.capacity()); }
  void Clear() { v_.clear(); }
  void ExtractSubrange(int start, int n, T* out) {
    for (int i = 0; i < n; ++i) {
      if (out != nullptr) out[i] = data()[start + i];
    }
    v_.erase(v_.begin() + start, v_.begin() + start + n);
  }
  void MergeFrom(const RepeatedField& other) { v_.insert(v_.end(), other.v_.begin(), other.v_.end()); }
  void CopyFrom(const RepeatedField& other) { v_ = other.v_; }
  void Swap(RepeatedField* other) { v_.swap(other->v_); }
  void SwapElements(int a, int b) { std::swap(v_[static_cast<size_t>(a)], v_[static_cast<size_t>(b)]); }
  T* mutable_data() { return reinterpret_cast<T*>(v_.data()); }
  const T* data() const { return reinterpret_cast<const T*>(v_.data()); }
  iterator erase(const_iterator pos) { return erase(pos, pos + 1); }
  iterator erase(const_iterator first, const_iterator last) {
    const auto from = first - data();
    v_.erase(v_.begin() + from, v_.begin() + (last - data()));
    return mutable_data() + from;
  }

  iterator begin() { return mutable_data(); }
  iterator end() { return mutable_data() + v_.size(); }
  const_iterator begin() const { return data(); }
  const_iterator end() const { return data() + v_.size(); }
  const_iterator cbegin() const { return begin(); }
  const_iterator cend() const { return end(); }
  reverse_iterator rbegin() { return reverse_iterator(end()); }
  reverse_iterator rend() { return reverse_iterator(begin()); }
  const_reverse_iterator rbegin() const { return const_reverse_iterator(end()); }
  const_reverse_iterator rend() const { return const_reverse_iterator(begin()); }

  bool operator==(const RepeatedField& o) const { return v_ == o.v_; }

 private:
  std::vector<Elem> v_;
};

namespace internal {

// What a repeated string or message field holds, untyped: the protobuf model's serializer works on
// it through the field's descriptor (it knows which type the elements are). Messages are kept as
// MessageLite pointers, strings as std::string pointers.
class RepeatedPtrFieldBase {
 public:
  int size() const { return static_cast<int>(items_.size()); }
  bool empty() const { return items_.empty(); }
  void* raw(int i) const { return items_[static_cast<size_t>(i)]; }
  void push_raw(void* item) { items_.push_back(item); }
  void* pop_raw() {
    void* item = items_.back();
    items_.pop_back();
    return item;
  }

 protected:
  std::vector<void*> items_;
};

}  // namespace internal

template <class T>
class RepeatedPtrField : public internal::RepeatedPtrFieldBase {
  static T* down(void* p) {
    if constexpr (std::is_base_of_v<MessageLite, T>) return static_cast<T*>(static_cast<MessageLite*>(p));
    else return static_cast<T*>(p);
  }
  static void* up(T* p) {
    if constexpr (std::is_base_of_v<MessageLite, T>) return static_cast<MessageLite*>(p);
    else return p;
  }

 public:
  template <class P, class R>
  class Iterator {
   public:
    using iterator_category = std::random_access_iterator_tag;
    using value_type = std::remove_const_t<R>;
    using difference_type = std::ptrdiff_t;
    using pointer = R*;
    using reference = R&;
    Iterator() = default;
    explicit Iterator(P it) : it_(it) {}
    template <class P2, class R2>
    Iterator(const Iterator<P2, R2>& o) : it_(o.base()) {}
    R& operator*() const { return *down(*it_); }
    R* operator->() const { return down(*it_); }
    R& operator[](difference_type n) const { return *down(it_[n]); }
    Iterator& operator++() { ++it_; return *this; }
    Iterator operator++(int) { Iterator t = *this; ++it_; return t; }
    Iterator& operator--() { --it_; return *this; }
    Iterator operator--(int) { Iterator t = *this; --it_; return t; }
    Iterator& operator+=(difference_type n) { it_ += n; return *this; }
    Iterator& operator-=(difference_type n) { it_ -= n; return *this; }
    friend Iterator operator+(Iterator a, difference_type n) { return a += n; }
    friend Iterator operator+(difference_type n, Iterator a) { return a += n; }
    friend Iterator operator-(Iterator a, difference_type n) { return a -= n; }
    friend difference_type operator-(const Iterator& a, const Iterator& b) { return a.it_ - b.it_; }
    friend bool operator==(const Iterator& a, const Iterator& b) { return a.it_ == b.it_; }
    friend auto operator<=>(const Iterator& a, const Iterator& b) { return a.it_ <=> b.it_; }
    P base() const { return it_; }

   private:
    P it_{};
  };
  using value_type = T;
  using size_type = int;
  using iterator = Iterator<std::vector<void*>::iterator, T>;
  using const_iterator = Iterator<std::vector<void*>::const_iterator, const T>;
  using reverse_iterator = std::reverse_iterator<iterator>;
  using const_reverse_iterator = std::reverse_iterator<const_iterator>;

  RepeatedPtrField() = default;
  RepeatedPtrField(const RepeatedPtrField& o) { MergeFrom(o); }
  RepeatedPtrField(RepeatedPtrField&& o) noexcept { items_.swap(o.items_); }
  template <class It>
  RepeatedPtrField(It first, It last) {
    for (; first != last; ++first) *Add() = *first;
  }
  RepeatedPtrField& operator=(const RepeatedPtrField& o) {
    if (this != &o) CopyFrom(o);
    return *this;
  }
  RepeatedPtrField& operator=(RepeatedPtrField&& o) noexcept {
    items_.swap(o.items_);
    return *this;
  }
  ~RepeatedPtrField() { Clear(); }

  const T& Get(int i) const { return *down(items_[static_cast<size_t>(i)]); }
  T* Mutable(int i) { return down(items_[static_cast<size_t>(i)]); }
  const T& operator[](int i) const { return Get(i); }
  T& operator[](int i) { return *Mutable(i); }
  const T& at(int i) const { return *down(items_.at(static_cast<size_t>(i))); }
  T& at(int i) { return *down(items_.at(static_cast<size_t>(i))); }
  T* Add() {
    T* item = new T();
    items_.push_back(up(item));
    return item;
  }
  void Add(const T& value) { *Add() = value; }
  void Add(T&& value) { *Add() = std::move(value); }
  template <class It>
  void Add(It first, It last) {
    for (; first != last; ++first) *Add() = *first;
  }
  void AddAllocated(T* item) { items_.push_back(up(item)); }
  T* ReleaseLast() {
    T* item = down(items_.back());
    items_.pop_back();
    return item;
  }
  void RemoveLast() { delete ReleaseLast(); }
  void DeleteSubrange(int start, int n) {
    for (int i = start; i < start + n; ++i) delete down(items_[static_cast<size_t>(i)]);
    items_.erase(items_.begin() + start, items_.begin() + start + n);
  }
  void Clear() {
    for (void* item : items_) delete down(item);
    items_.clear();
  }
  void Reserve(int n) { items_.reserve(static_cast<size_t>(n)); }
  int Capacity() const { return static_cast<int>(items_.capacity()); }
  void MergeFrom(const RepeatedPtrField& other) {
    for (int i = 0; i < other.size(); ++i) *Add() = other.Get(i);
  }
  void CopyFrom(const RepeatedPtrField& other) {
    if (this == &other) return;
    Clear();
    MergeFrom(other);
  }
  void Swap(RepeatedPtrField* other) { items_.swap(other->items_); }
  void SwapElements(int a, int b) { std::swap(items_[static_cast<size_t>(a)], items_[static_cast<size_t>(b)]); }
  iterator erase(const_iterator pos) { return erase(pos, pos + 1); }
  iterator erase(const_iterator first, const_iterator last) {
    const auto from = first.base() - items_.cbegin();
    const auto to = last.base() - items_.cbegin();
    for (auto i = from; i < to; ++i) delete down(items_[static_cast<size_t>(i)]);
    return iterator(items_.erase(items_.begin() + from, items_.begin() + to));
  }

  iterator begin() { return iterator(items_.begin()); }
  iterator end() { return iterator(items_.end()); }
  const_iterator begin() const { return const_iterator(items_.begin()); }
  const_iterator end() const { return const_iterator(items_.end()); }
  const_iterator cbegin() const { return begin(); }
  const_iterator cend() const { return end(); }
  reverse_iterator rbegin() { return reverse_iterator(end()); }
  reverse_iterator rend() { return reverse_iterator(begin()); }
  const_reverse_iterator rbegin() const { return const_reverse_iterator(end()); }
  const_reverse_iterator rend() const { return const_reverse_iterator(begin()); }
};

}  // namespace google::protobuf
