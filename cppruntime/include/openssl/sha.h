// OpenSSL's <openssl/sha.h>, as the LeetBuild C++ runtime models it: SHA-1 and the SHA-2 family,
// one-shot and incremental, computed in process (cppruntime/src/openssl.cpp).
#pragma once

#include <cstddef>
#include <cstdint>

#include <openssl/crypto.h>

#define SHA_DIGEST_LENGTH 20
#define SHA224_DIGEST_LENGTH 28
#define SHA256_DIGEST_LENGTH 32
#define SHA384_DIGEST_LENGTH 48
#define SHA512_DIGEST_LENGTH 64
#define SHA_CBLOCK 64
#define SHA256_CBLOCK 64
#define SHA512_CBLOCK 128

typedef struct SHAstate_st {
  uint32_t h[5];
  uint64_t length;
  unsigned char block[64];
  unsigned int num;
} SHA_CTX;

typedef struct SHA256state_st {
  uint32_t h[8];
  uint64_t length;
  unsigned char block[64];
  unsigned int num;
  unsigned int md_len;
} SHA256_CTX;

typedef struct SHA512state_st {
  uint64_t h[8];
  uint64_t length;
  unsigned char block[128];
  unsigned int num;
  unsigned int md_len;
} SHA512_CTX;

int SHA1_Init(SHA_CTX* c);
int SHA1_Update(SHA_CTX* c, const void* data, size_t len);
int SHA1_Final(unsigned char* md, SHA_CTX* c);
unsigned char* SHA1(const unsigned char* d, size_t n, unsigned char* md);

int SHA224_Init(SHA256_CTX* c);
int SHA224_Update(SHA256_CTX* c, const void* data, size_t len);
int SHA224_Final(unsigned char* md, SHA256_CTX* c);
unsigned char* SHA224(const unsigned char* d, size_t n, unsigned char* md);

int SHA256_Init(SHA256_CTX* c);
int SHA256_Update(SHA256_CTX* c, const void* data, size_t len);
int SHA256_Final(unsigned char* md, SHA256_CTX* c);
unsigned char* SHA256(const unsigned char* d, size_t n, unsigned char* md);

int SHA384_Init(SHA512_CTX* c);
int SHA384_Update(SHA512_CTX* c, const void* data, size_t len);
int SHA384_Final(unsigned char* md, SHA512_CTX* c);
unsigned char* SHA384(const unsigned char* d, size_t n, unsigned char* md);

int SHA512_Init(SHA512_CTX* c);
int SHA512_Update(SHA512_CTX* c, const void* data, size_t len);
int SHA512_Final(unsigned char* md, SHA512_CTX* c);
unsigned char* SHA512(const unsigned char* d, size_t n, unsigned char* md);
