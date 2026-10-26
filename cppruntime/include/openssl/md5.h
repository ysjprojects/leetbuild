// OpenSSL's <openssl/md5.h>, as the LeetBuild C++ runtime models it (cppruntime/src/openssl.cpp).
#pragma once

#include <cstddef>
#include <cstdint>

#include <openssl/crypto.h>

#define MD5_DIGEST_LENGTH 16
#define MD5_CBLOCK 64

typedef struct MD5state_st {
  uint32_t h[4];
  uint64_t length;
  unsigned char block[64];
  unsigned int num;
} MD5_CTX;

int MD5_Init(MD5_CTX* c);
int MD5_Update(MD5_CTX* c, const void* data, size_t len);
int MD5_Final(unsigned char* md, MD5_CTX* c);
unsigned char* MD5(const unsigned char* d, size_t n, unsigned char* md);
