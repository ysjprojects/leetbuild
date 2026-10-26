// OpenSSL's <openssl/hmac.h>, as the LeetBuild C++ runtime models it: HMAC over any EVP_MD digest
// (cppruntime/src/openssl.cpp).
#pragma once

#include <cstddef>

#include <openssl/evp.h>

typedef struct hmac_ctx_st HMAC_CTX;

// HMAC of data under key with md into md_out (EVP_MAX_MD_SIZE bytes suffice), its length in *md_len.
unsigned char* HMAC(const EVP_MD* evp_md, const void* key, int key_len, const unsigned char* data, size_t data_len,
                    unsigned char* md_out, unsigned int* md_len);

HMAC_CTX* HMAC_CTX_new();
void HMAC_CTX_free(HMAC_CTX* ctx);
int HMAC_CTX_reset(HMAC_CTX* ctx);
int HMAC_Init_ex(HMAC_CTX* ctx, const void* key, int key_len, const EVP_MD* md, ENGINE* impl);
int HMAC_Update(HMAC_CTX* ctx, const unsigned char* data, size_t len);
int HMAC_Final(HMAC_CTX* ctx, unsigned char* md, unsigned int* len);
size_t HMAC_size(const HMAC_CTX* ctx);
