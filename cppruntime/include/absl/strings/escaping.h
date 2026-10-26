// Abseil's base64 functions (absl/strings/escaping.h). Implemented in cppruntime/src/absl.cpp.
#pragma once

#include <string>
#include <string_view>

namespace absl {

// Standard base64, padded with '='.
std::string Base64Escape(std::string_view src);
void Base64Escape(std::string_view src, std::string* dest);
// URL-safe base64 ('-' and '_'), without padding.
std::string WebSafeBase64Escape(std::string_view src);
void WebSafeBase64Escape(std::string_view src, std::string* dest);
// Decode; false when src is not base64 of that alphabet (padding is optional).
bool Base64Unescape(std::string_view src, std::string* dest);
bool WebSafeBase64Unescape(std::string_view src, std::string* dest);

std::string BytesToHexString(std::string_view from);
std::string HexStringToBytes(std::string_view from);

}  // namespace absl
