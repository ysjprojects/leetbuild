// The libuuid model's compiled half (cppruntime/include/uuid/uuid.h).
#include <uuid/uuid.h>

#include <cctype>
#include <cstdio>
#include <cstring>
#include <random>

namespace {

void unparse(const uuid_t uu, char* out, const char* digits) {
  int at = 0;
  for (int i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out[at++] = '-';
    out[at++] = digits[uu[i] >> 4];
    out[at++] = digits[uu[i] & 15];
  }
  out[at] = '\0';
}

}  // namespace

void uuid_generate_random(uuid_t out) {
  static std::mt19937_64 gen{std::random_device{}()};
  for (int i = 0; i < 16; i++) out[i] = static_cast<unsigned char>(gen());
  out[6] = static_cast<unsigned char>((out[6] & 0x0f) | 0x40);
  out[8] = static_cast<unsigned char>((out[8] & 0x3f) | 0x80);
}
void uuid_generate(uuid_t out) { uuid_generate_random(out); }
void uuid_generate_time(uuid_t out) { uuid_generate_random(out); }
void uuid_unparse(const uuid_t uu, char* out) { unparse(uu, out, "0123456789abcdef"); }
void uuid_unparse_lower(const uuid_t uu, char* out) { unparse(uu, out, "0123456789abcdef"); }
void uuid_unparse_upper(const uuid_t uu, char* out) { unparse(uu, out, "0123456789ABCDEF"); }

int uuid_parse(const char* in, uuid_t uu) {
  if (in == nullptr || std::strlen(in) != 36) return -1;
  int byte = 0;
  for (int i = 0; i < 36;) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (in[i] != '-') return -1;
      i++;
      continue;
    }
    if (!std::isxdigit(static_cast<unsigned char>(in[i])) || !std::isxdigit(static_cast<unsigned char>(in[i + 1]))) {
      return -1;
    }
    unsigned v = 0;
    std::sscanf(in + i, "%2x", &v);
    uu[byte++] = static_cast<unsigned char>(v);
    i += 2;
  }
  return 0;
}

void uuid_clear(uuid_t uu) { std::memset(uu, 0, 16); }
int uuid_is_null(const uuid_t uu) {
  for (int i = 0; i < 16; i++) {
    if (uu[i] != 0) return 0;
  }
  return 1;
}
int uuid_compare(const uuid_t uu1, const uuid_t uu2) {
  const int c = std::memcmp(uu1, uu2, 16);
  return c < 0 ? -1 : c > 0 ? 1 : 0;
}
void uuid_copy(uuid_t dst, const uuid_t src) { std::memcpy(dst, src, 16); }
