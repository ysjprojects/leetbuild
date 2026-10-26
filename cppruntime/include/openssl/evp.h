// OpenSSL's <openssl/evp.h>, as the LeetBuild C++ runtime models it: message digests by EVP_MD
// (MD5, SHA-1, SHA-2) and base64 blocks (cppruntime/src/openssl.cpp).
#pragma once

#include <cstddef>

#include <openssl/crypto.h>

#define EVP_MAX_MD_SIZE 64
#define EVP_MAX_BLOCK_LENGTH 32

typedef struct evp_md_st EVP_MD;
typedef struct evp_md_ctx_st EVP_MD_CTX;
typedef struct engine_st ENGINE;

const EVP_MD* EVP_md5();
const EVP_MD* EVP_sha1();
const EVP_MD* EVP_sha224();
const EVP_MD* EVP_sha256();
const EVP_MD* EVP_sha384();
const EVP_MD* EVP_sha512();
// A digest by name ("SHA256", "sha-256", "md5", …), or nullptr.
const EVP_MD* EVP_get_digestbyname(const char* name);

int EVP_MD_get_size(const EVP_MD* md);
int EVP_MD_get_block_size(const EVP_MD* md);
#define EVP_MD_size EVP_MD_get_size
#define EVP_MD_block_size EVP_MD_get_block_size

EVP_MD_CTX* EVP_MD_CTX_new();
void EVP_MD_CTX_free(EVP_MD_CTX* ctx);
int EVP_MD_CTX_reset(EVP_MD_CTX* ctx);
#define EVP_MD_CTX_create EVP_MD_CTX_new
#define EVP_MD_CTX_destroy EVP_MD_CTX_free

int EVP_DigestInit_ex(EVP_MD_CTX* ctx, const EVP_MD* type, ENGINE* impl);
int EVP_DigestInit(EVP_MD_CTX* ctx, const EVP_MD* type);
int EVP_DigestUpdate(EVP_MD_CTX* ctx, const void* d, size_t cnt);
int EVP_DigestFinal_ex(EVP_MD_CTX* ctx, unsigned char* md, unsigned int* s);
int EVP_DigestFinal(EVP_MD_CTX* ctx, unsigned char* md, unsigned int* s);
int EVP_Digest(const void* data, size_t count, unsigned char* md, unsigned int* size, const EVP_MD* type, ENGINE* impl);

// Base64 of n bytes (with padding, no newlines) into t, NUL-terminated; its length.
int EVP_EncodeBlock(unsigned char* t, const unsigned char* f, int n);
// The bytes of base64 text (padding decodes as zero bytes, as OpenSSL does); their count, or -1.
int EVP_DecodeBlock(unsigned char* t, const unsigned char* f, int n);
