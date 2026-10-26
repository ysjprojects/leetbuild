// OpenSSL's <openssl/crypto.h>, as the LeetBuild C++ runtime models it (cppruntime/src/openssl.cpp).
#pragma once

#include <cstddef>
#include <cstdlib>

#include <openssl/opensslv.h>

// Overwrite len bytes at ptr with zeros, in a way the compiler keeps.
void OPENSSL_cleanse(void* ptr, size_t len);
// 0 when the len bytes at a and b are equal, in time that does not depend on where they differ.
int CRYPTO_memcmp(const void* a, const void* b, size_t len);

#define OPENSSL_malloc(n) std::malloc(n)
#define OPENSSL_free(p) std::free(p)
