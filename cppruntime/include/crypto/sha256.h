// A SHA-256 hasher class (Bitcoin Core's crypto/sha256.h shape: init/update/final, DIGEST_SIZE),
// as the LeetBuild C++ runtime models it on its OpenSSL model's SHA-256 (cppruntime/src/openssl.cpp).
#pragma once

#include <cstddef>

namespace lb::crypto {
void sha256_init(void* state);
void sha256_update(void* state, const unsigned char* data, size_t len);
void sha256_final(void* state, unsigned char* hash);
}  // namespace lb::crypto

class CSHA256 {
 public:
  static constexpr size_t OUTPUT_SIZE = 32;
  static constexpr size_t DIGEST_SIZE = 32;

  CSHA256() { lb::crypto::sha256_init(state_); }
  CSHA256& init() {
    lb::crypto::sha256_init(state_);
    return *this;
  }
  CSHA256& Reset() { return init(); }
  CSHA256& update(const unsigned char* data, size_t len) {
    lb::crypto::sha256_update(state_, data, len);
    return *this;
  }
  CSHA256& Write(const unsigned char* data, size_t len) { return update(data, len); }
  void final(unsigned char* hash) { lb::crypto::sha256_final(state_, hash); }
  void Finalize(unsigned char hash[OUTPUT_SIZE]) { final(hash); }

 private:
  alignas(8) unsigned char state_[128];
};

// `SHA256 ctx; ctx.init(); ctx.update(…); ctx.final(digest);` (not with <openssl/sha.h>, whose
// SHA256 is a function).
using SHA256 = CSHA256;
