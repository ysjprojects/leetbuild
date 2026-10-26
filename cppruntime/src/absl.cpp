// The Abseil model's compiled half (cppruntime/include/absl): absl::Status and base64.
#include <absl/status/status.h>
#include <absl/strings/escaping.h>

#include <ostream>

namespace absl {

std::string StatusCodeToString(StatusCode code) {
  static const char* const names[] = {
      "OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND",
      "ALREADY_EXISTS", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED",
      "OUT_OF_RANGE", "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED",
  };
  const int n = static_cast<int>(code);
  return n >= 0 && n <= 16 ? names[n] : "";
}

std::string Status::ToString() const {
  if (ok()) return "OK";
  return StatusCodeToString(code_) + ": " + message_;
}

std::ostream& operator<<(std::ostream& out, const Status& status) { return out << status.ToString(); }

namespace {

const char kStd[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const char kWeb[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

std::string encode(std::string_view src, const char* alphabet, bool pad) {
  std::string out;
  size_t i = 0;
  for (; i + 2 < src.size(); i += 3) {
    const unsigned n = (static_cast<unsigned char>(src[i]) << 16) | (static_cast<unsigned char>(src[i + 1]) << 8) |
                       static_cast<unsigned char>(src[i + 2]);
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += alphabet[(n >> 6) & 63];
    out += alphabet[n & 63];
  }
  const size_t rest = src.size() - i;
  if (rest > 0) {
    unsigned n = static_cast<unsigned char>(src[i]) << 16;
    if (rest == 2) n |= static_cast<unsigned char>(src[i + 1]) << 8;
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    if (rest == 2) out += alphabet[(n >> 6) & 63];
    if (pad) out.append(rest == 1 ? "==" : "=");
  }
  return out;
}

bool decode(std::string_view src, const char* alphabet, std::string* dest) {
  int value[256];
  for (int& v : value) v = -1;
  for (int i = 0; i < 64; ++i) value[static_cast<unsigned char>(alphabet[i])] = i;
  while (!src.empty() && src.back() == '=') src.remove_suffix(1);
  if (src.size() % 4 == 1) return false;
  std::string out;
  unsigned bits = 0;
  int count = 0;
  for (char c : src) {
    const int v = value[static_cast<unsigned char>(c)];
    if (v < 0) return false;
    bits = (bits << 6) | static_cast<unsigned>(v);
    count += 6;
    if (count >= 8) {
      count -= 8;
      out += static_cast<char>((bits >> count) & 0xff);
    }
  }
  *dest = std::move(out);
  return true;
}

}  // namespace

std::string Base64Escape(std::string_view src) { return encode(src, kStd, true); }
void Base64Escape(std::string_view src, std::string* dest) { *dest = encode(src, kStd, true); }
std::string WebSafeBase64Escape(std::string_view src) { return encode(src, kWeb, false); }
void WebSafeBase64Escape(std::string_view src, std::string* dest) { *dest = encode(src, kWeb, false); }
bool Base64Unescape(std::string_view src, std::string* dest) { return decode(src, kStd, dest); }
bool WebSafeBase64Unescape(std::string_view src, std::string* dest) { return decode(src, kWeb, dest); }

std::string BytesToHexString(std::string_view from) {
  static const char digits[] = "0123456789abcdef";
  std::string out;
  for (unsigned char c : from) {
    out += digits[c >> 4];
    out += digits[c & 15];
  }
  return out;
}

std::string HexStringToBytes(std::string_view from) {
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
  };
  std::string out;
  for (size_t i = 0; i + 1 < from.size(); i += 2) out += static_cast<char>((nibble(from[i]) << 4) | nibble(from[i + 1]));
  return out;
}

}  // namespace absl
