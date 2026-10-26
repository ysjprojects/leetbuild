// grpc::string_ref: a view of metadata bytes (what ServerContext::client_metadata() and
// ClientContext::GetServerTrailingMetadata() hold), as gRPC's.
#pragma once

#include <cstddef>
#include <cstring>
#include <iosfwd>
#include <string>
#include <string_view>

namespace grpc {

class string_ref {
 public:
  using const_iterator = const char*;
  using iterator = const char*;
  static constexpr size_t npos = size_t(-1);

  string_ref() = default;
  string_ref(const char* s) : data_(s), length_(std::strlen(s)) {}
  string_ref(const char* s, size_t n) : data_(s), length_(n) {}
  string_ref(const std::string& s) : data_(s.data()), length_(s.size()) {}

  const char* data() const { return data_; }
  size_t size() const { return length_; }
  size_t length() const { return length_; }
  size_t max_size() const { return length_; }
  bool empty() const { return length_ == 0; }
  const_iterator begin() const { return data_; }
  const_iterator end() const { return data_ + length_; }
  const_iterator cbegin() const { return begin(); }
  const_iterator cend() const { return end(); }

  std::string_view view() const { return std::string_view(data_, length_); }
  int compare(string_ref x) const { return view().compare(x.view()); }
  bool starts_with(string_ref x) const { return view().substr(0, x.size()) == x.view(); }
  bool ends_with(string_ref x) const { return length_ >= x.size() && view().substr(length_ - x.size()) == x.view(); }
  size_t find(string_ref s) const { return view().find(s.view()); }
  size_t find(char c) const { return view().find(c); }
  string_ref substr(size_t start, size_t n = npos) const {
    const std::string_view v = view().substr(start, n);
    return string_ref(v.data(), v.size());
  }

 private:
  const char* data_ = nullptr;
  size_t length_ = 0;
};

inline bool operator==(string_ref a, string_ref b) { return a.compare(b) == 0; }
inline bool operator!=(string_ref a, string_ref b) { return a.compare(b) != 0; }
inline bool operator<(string_ref a, string_ref b) { return a.compare(b) < 0; }
inline bool operator<=(string_ref a, string_ref b) { return a.compare(b) <= 0; }
inline bool operator>(string_ref a, string_ref b) { return a.compare(b) > 0; }
inline bool operator>=(string_ref a, string_ref b) { return a.compare(b) >= 0; }
std::ostream& operator<<(std::ostream& out, const string_ref& s);

}  // namespace grpc
