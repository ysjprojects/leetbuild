// OpenSSL's <openssl/ssl.h>, as the LeetBuild C++ runtime models it: an SSL_CTX records what a
// program configures (protocol versions, options, ciphers, certificate and key files) for the
// harness to read; no handshake happens in process (cppruntime/src/openssl.cpp). An
// httplib::SSLServer's ssl_context() is one.
#pragma once

#include <cstdint>

#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>

#define SSL3_VERSION 0x0300
#define TLS1_VERSION 0x0301
#define TLS1_1_VERSION 0x0302
#define TLS1_2_VERSION 0x0303
#define TLS1_3_VERSION 0x0304

#define SSL_FILETYPE_PEM 1
#define SSL_FILETYPE_ASN1 2

#define SSL_VERIFY_NONE 0x00
#define SSL_VERIFY_PEER 0x01
#define SSL_VERIFY_FAIL_IF_NO_PEER_CERT 0x02

#define SSL_OP_NO_SSLv3 0x02000000UL
#define SSL_OP_NO_TLSv1 0x04000000UL
#define SSL_OP_NO_TLSv1_2 0x08000000UL
#define SSL_OP_NO_TLSv1_1 0x10000000UL
#define SSL_OP_NO_TLSv1_3 0x20000000UL
#define SSL_OP_NO_COMPRESSION 0x00020000UL
#define SSL_OP_ALL 0x80000850UL

typedef struct ssl_ctx_st SSL_CTX;
typedef struct ssl_st SSL;
typedef struct ssl_method_st SSL_METHOD;

// What the model records about a context (also readable directly by a harness).
struct ssl_ctx_st {
  int min_proto_version = 0;  // 0: no bound (TLS 1.0 and up)
  int max_proto_version = 0;  // 0: no bound (up to TLS 1.3)
  uint64_t options = 0;
  int verify_mode = SSL_VERIFY_NONE;
  bool server = true;
  char cipher_list[512] = {};
  char ciphersuites[512] = {};
  char certificate_file[512] = {};
  char private_key_file[512] = {};
};

const SSL_METHOD* TLS_method();
const SSL_METHOD* TLS_server_method();
const SSL_METHOD* TLS_client_method();
#define SSLv23_method TLS_method
#define SSLv23_server_method TLS_server_method
#define SSLv23_client_method TLS_client_method

int OPENSSL_init_ssl(uint64_t opts, const void* settings);
#define SSL_library_init() OPENSSL_init_ssl(0, nullptr)
#define SSL_load_error_strings() ((void)0)
#define OpenSSL_add_all_algorithms() ((void)0)

SSL_CTX* SSL_CTX_new(const SSL_METHOD* method);
void SSL_CTX_free(SSL_CTX* ctx);

int SSL_CTX_set_min_proto_version(SSL_CTX* ctx, int version);
int SSL_CTX_set_max_proto_version(SSL_CTX* ctx, int version);
int SSL_CTX_get_min_proto_version(SSL_CTX* ctx);
int SSL_CTX_get_max_proto_version(SSL_CTX* ctx);
uint64_t SSL_CTX_set_options(SSL_CTX* ctx, uint64_t op);
uint64_t SSL_CTX_clear_options(SSL_CTX* ctx, uint64_t op);
uint64_t SSL_CTX_get_options(const SSL_CTX* ctx);
int SSL_CTX_set_cipher_list(SSL_CTX* ctx, const char* str);
int SSL_CTX_set_ciphersuites(SSL_CTX* ctx, const char* str);
void SSL_CTX_set_verify(SSL_CTX* ctx, int mode, int (*callback)(int, void*));
int SSL_CTX_use_certificate_chain_file(SSL_CTX* ctx, const char* file);
int SSL_CTX_use_certificate_file(SSL_CTX* ctx, const char* file, int type);
int SSL_CTX_use_PrivateKey_file(SSL_CTX* ctx, const char* file, int type);
int SSL_CTX_check_private_key(const SSL_CTX* ctx);
int SSL_CTX_load_verify_locations(SSL_CTX* ctx, const char* ca_file, const char* ca_path);
int SSL_CTX_set_default_verify_paths(SSL_CTX* ctx);
