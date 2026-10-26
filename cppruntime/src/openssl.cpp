// The OpenSSL model's compiled half (cppruntime/include/openssl/*.h): MD5, SHA-1, SHA-2, HMAC,
// base64 blocks, random bytes, and SSL_CTX records.
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/md5.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <openssl/ssl.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>

namespace {

inline uint32_t rotl32(uint32_t x, int n) { return (x << n) | (x >> (32 - n)); }
inline uint32_t rotr32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
inline uint64_t rotr64(uint64_t x, int n) { return (x >> n) | (x << (64 - n)); }

uint32_t be32(const unsigned char* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}
uint64_t be64(const unsigned char* p) { return (uint64_t(be32(p)) << 32) | be32(p + 4); }
uint32_t le32(const unsigned char* p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}
void put_be32(unsigned char* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = static_cast<unsigned char>(v >> (24 - 8 * i));
}
void put_be64(unsigned char* p, uint64_t v) {
  for (int i = 0; i < 8; i++) p[i] = static_cast<unsigned char>(v >> (56 - 8 * i));
}
void put_le32(unsigned char* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = static_cast<unsigned char>(v >> (8 * i));
}

// Buffer bytes into blocks of N and compress each; shared by every Merkle–Damgård digest here.
template <size_t N, class Ctx, class Compress>
void absorb(Ctx* c, const void* data, size_t len, Compress compress) {
  const auto* p = static_cast<const unsigned char*>(data);
  c->length += len;
  while (len > 0) {
    const size_t take = std::min(len, N - c->num);
    std::memcpy(c->block + c->num, p, take);
    c->num += static_cast<unsigned int>(take);
    p += take;
    len -= take;
    if (c->num == N) {
      compress(c->h, c->block);
      c->num = 0;
    }
  }
}

// Pad (0x80, zeros, the bit length in `lenbytes` bytes, big or little endian) and compress the rest.
template <size_t N, class Ctx, class Compress>
void pad(Ctx* c, size_t lenbytes, bool big_endian, Compress compress) {
  const uint64_t bits = c->length * 8;
  c->block[c->num++] = 0x80;
  if (c->num > N - lenbytes) {
    std::memset(c->block + c->num, 0, N - c->num);
    compress(c->h, c->block);
    c->num = 0;
  }
  std::memset(c->block + c->num, 0, N - c->num);
  if (big_endian) {
    put_be64(c->block + N - 8, bits);
  } else {
    for (int i = 0; i < 8; i++) c->block[N - lenbytes + i] = static_cast<unsigned char>(bits >> (8 * i));
  }
  compress(c->h, c->block);
  c->num = 0;
}

void sha1_compress(uint32_t* h, const unsigned char* block) {
  uint32_t w[80];
  for (int i = 0; i < 16; i++) w[i] = be32(block + 4 * i);
  for (int i = 16; i < 80; i++) w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
  for (int i = 0; i < 80; i++) {
    uint32_t f, k;
    if (i < 20) {
      f = (b & c) | (~b & d);
      k = 0x5a827999;
    } else if (i < 40) {
      f = b ^ c ^ d;
      k = 0x6ed9eba1;
    } else if (i < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8f1bbcdc;
    } else {
      f = b ^ c ^ d;
      k = 0xca62c1d6;
    }
    const uint32_t t = rotl32(a, 5) + f + e + k + w[i];
    e = d;
    d = c;
    c = rotl32(b, 30);
    b = a;
    a = t;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
}

const uint32_t K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2};

void sha256_compress(uint32_t* h, const unsigned char* block) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) w[i] = be32(block + 4 * i);
  for (int i = 16; i < 64; i++) {
    const uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
    const uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 64; i++) {
    const uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    const uint32_t ch = (e & f) ^ (~e & g);
    const uint32_t t1 = hh + S1 + ch + K256[i] + w[i];
    const uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t t2 = S0 + maj;
    hh = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
  h[5] += f;
  h[6] += g;
  h[7] += hh;
}

const uint64_t K512[80] = {
    0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL, 0x3956c25bf348b538ULL,
    0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL, 0xd807aa98a3030242ULL, 0x12835b0145706fbeULL,
    0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL, 0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL,
    0xc19bf174cf692694ULL, 0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL,
    0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL, 0x983e5152ee66dfabULL,
    0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL, 0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL,
    0x06ca6351e003826fULL, 0x142929670a0e6e70ULL, 0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL,
    0x53380d139d95b3dfULL, 0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL,
    0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL, 0xd192e819d6ef5218ULL,
    0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL, 0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL,
    0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL, 0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL,
    0x682e6ff3d6b2b8a3ULL, 0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
    0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL, 0xca273eceea26619cULL,
    0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL, 0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL,
    0x113f9804bef90daeULL, 0x1b710b35131c471bULL, 0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL,
    0x431d67c49c100d4cULL, 0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL};

void sha512_compress(uint64_t* h, const unsigned char* block) {
  uint64_t w[80];
  for (int i = 0; i < 16; i++) w[i] = be64(block + 8 * i);
  for (int i = 16; i < 80; i++) {
    const uint64_t s0 = rotr64(w[i - 15], 1) ^ rotr64(w[i - 15], 8) ^ (w[i - 15] >> 7);
    const uint64_t s1 = rotr64(w[i - 2], 19) ^ rotr64(w[i - 2], 61) ^ (w[i - 2] >> 6);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint64_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 80; i++) {
    const uint64_t S1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
    const uint64_t ch = (e & f) ^ (~e & g);
    const uint64_t t1 = hh + S1 + ch + K512[i] + w[i];
    const uint64_t S0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
    const uint64_t maj = (a & b) ^ (a & c) ^ (b & c);
    const uint64_t t2 = S0 + maj;
    hh = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
  h[5] += f;
  h[6] += g;
  h[7] += hh;
}

const uint32_t MD5_K[64] = {
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
    0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
    0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
    0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
    0xeb86d391};
const int MD5_S[64] = {7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9,  14, 20, 5, 9,
                       14, 20, 5, 9,  14, 20, 5, 9,  14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
                       4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21};

void md5_compress(uint32_t* h, const unsigned char* block) {
  uint32_t m[16];
  for (int i = 0; i < 16; i++) m[i] = le32(block + 4 * i);
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
  for (int i = 0; i < 64; i++) {
    uint32_t f;
    int g;
    if (i < 16) {
      f = (b & c) | (~b & d);
      g = i;
    } else if (i < 32) {
      f = (d & b) | (~d & c);
      g = (5 * i + 1) % 16;
    } else if (i < 48) {
      f = b ^ c ^ d;
      g = (3 * i + 5) % 16;
    } else {
      f = c ^ (b | ~d);
      g = (7 * i) % 16;
    }
    const uint32_t t = d;
    d = c;
    c = b;
    b = b + rotl32(a + f + MD5_K[i] + m[g], MD5_S[i]);
    a = t;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
}

}  // namespace

// ---- crypto.h -----------------------------------------------------------------------------------

void OPENSSL_cleanse(void* ptr, size_t len) {
  volatile auto* p = static_cast<volatile unsigned char*>(ptr);
  while (len-- > 0) *p++ = 0;
}

int CRYPTO_memcmp(const void* a, const void* b, size_t len) {
  const auto* x = static_cast<const unsigned char*>(a);
  const auto* y = static_cast<const unsigned char*>(b);
  unsigned char diff = 0;
  for (size_t i = 0; i < len; i++) diff |= x[i] ^ y[i];
  return diff;
}

// ---- sha.h --------------------------------------------------------------------------------------

int SHA1_Init(SHA_CTX* c) {
  *c = SHA_CTX{{0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0}, 0, {}, 0};
  return 1;
}
int SHA1_Update(SHA_CTX* c, const void* data, size_t len) {
  absorb<64>(c, data, len, sha1_compress);
  return 1;
}
int SHA1_Final(unsigned char* md, SHA_CTX* c) {
  pad<64>(c, 8, true, sha1_compress);
  for (int i = 0; i < 5; i++) put_be32(md + 4 * i, c->h[i]);
  return 1;
}
unsigned char* SHA1(const unsigned char* d, size_t n, unsigned char* md) {
  static unsigned char out[SHA_DIGEST_LENGTH];
  if (md == nullptr) md = out;
  SHA_CTX c;
  SHA1_Init(&c);
  SHA1_Update(&c, d, n);
  SHA1_Final(md, &c);
  return md;
}

int SHA224_Init(SHA256_CTX* c) {
  *c = SHA256_CTX{{0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4},
                  0, {}, 0, SHA224_DIGEST_LENGTH};
  return 1;
}
int SHA256_Init(SHA256_CTX* c) {
  *c = SHA256_CTX{{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19},
                  0, {}, 0, SHA256_DIGEST_LENGTH};
  return 1;
}
int SHA256_Update(SHA256_CTX* c, const void* data, size_t len) {
  absorb<64>(c, data, len, sha256_compress);
  return 1;
}
int SHA224_Update(SHA256_CTX* c, const void* data, size_t len) { return SHA256_Update(c, data, len); }
int SHA256_Final(unsigned char* md, SHA256_CTX* c) {
  pad<64>(c, 8, true, sha256_compress);
  for (unsigned i = 0; i < c->md_len / 4; i++) put_be32(md + 4 * i, c->h[i]);
  return 1;
}
int SHA224_Final(unsigned char* md, SHA256_CTX* c) { return SHA256_Final(md, c); }
unsigned char* SHA224(const unsigned char* d, size_t n, unsigned char* md) {
  static unsigned char out[SHA224_DIGEST_LENGTH];
  if (md == nullptr) md = out;
  SHA256_CTX c;
  SHA224_Init(&c);
  SHA256_Update(&c, d, n);
  SHA256_Final(md, &c);
  return md;
}
unsigned char* SHA256(const unsigned char* d, size_t n, unsigned char* md) {
  static unsigned char out[SHA256_DIGEST_LENGTH];
  if (md == nullptr) md = out;
  SHA256_CTX c;
  SHA256_Init(&c);
  SHA256_Update(&c, d, n);
  SHA256_Final(md, &c);
  return md;
}

int SHA384_Init(SHA512_CTX* c) {
  *c = SHA512_CTX{{0xcbbb9d5dc1059ed8ULL, 0x629a292a367cd507ULL, 0x9159015a3070dd17ULL, 0x152fecd8f70e5939ULL,
                   0x67332667ffc00b31ULL, 0x8eb44a8768581511ULL, 0xdb0c2e0d64f98fa7ULL, 0x47b5481dbefa4fa4ULL},
                  0, {}, 0, SHA384_DIGEST_LENGTH};
  return 1;
}
int SHA512_Init(SHA512_CTX* c) {
  *c = SHA512_CTX{{0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
                   0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL, 0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL},
                  0, {}, 0, SHA512_DIGEST_LENGTH};
  return 1;
}
int SHA512_Update(SHA512_CTX* c, const void* data, size_t len) {
  absorb<128>(c, data, len, sha512_compress);
  return 1;
}
int SHA384_Update(SHA512_CTX* c, const void* data, size_t len) { return SHA512_Update(c, data, len); }
int SHA512_Final(unsigned char* md, SHA512_CTX* c) {
  // A 128-bit length; lengths here fit in the low 64 bits.
  pad<128>(c, 16, true, sha512_compress);
  for (unsigned i = 0; i < c->md_len / 8; i++) put_be64(md + 8 * i, c->h[i]);
  return 1;
}
int SHA384_Final(unsigned char* md, SHA512_CTX* c) { return SHA512_Final(md, c); }
unsigned char* SHA384(const unsigned char* d, size_t n, unsigned char* md) {
  static unsigned char out[SHA384_DIGEST_LENGTH];
  if (md == nullptr) md = out;
  SHA512_CTX c;
  SHA384_Init(&c);
  SHA512_Update(&c, d, n);
  SHA512_Final(md, &c);
  return md;
}
unsigned char* SHA512(const unsigned char* d, size_t n, unsigned char* md) {
  static unsigned char out[SHA512_DIGEST_LENGTH];
  if (md == nullptr) md = out;
  SHA512_CTX c;
  SHA512_Init(&c);
  SHA512_Update(&c, d, n);
  SHA512_Final(md, &c);
  return md;
}

// ---- md5.h --------------------------------------------------------------------------------------

int MD5_Init(MD5_CTX* c) {
  *c = MD5_CTX{{0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476}, 0, {}, 0};
  return 1;
}
int MD5_Update(MD5_CTX* c, const void* data, size_t len) {
  absorb<64>(c, data, len, md5_compress);
  return 1;
}
int MD5_Final(unsigned char* md, MD5_CTX* c) {
  pad<64>(c, 8, false, md5_compress);
  for (int i = 0; i < 4; i++) put_le32(md + 4 * i, c->h[i]);
  return 1;
}
unsigned char* MD5(const unsigned char* d, size_t n, unsigned char* md) {
  static unsigned char out[MD5_DIGEST_LENGTH];
  if (md == nullptr) md = out;
  MD5_CTX c;
  MD5_Init(&c);
  MD5_Update(&c, d, n);
  MD5_Final(md, &c);
  return md;
}

// ---- evp.h --------------------------------------------------------------------------------------

enum class Algo { MD5, SHA1, SHA224, SHA256, SHA384, SHA512 };

struct evp_md_st {
  Algo algo;
  int size;
  int block;
};

struct evp_md_ctx_st {
  const EVP_MD* md = nullptr;
  union {
    MD5_CTX md5;
    SHA_CTX sha1;
    SHA256_CTX sha256;
    SHA512_CTX sha512;
  } u;
};

namespace {

const EVP_MD kMd5{Algo::MD5, MD5_DIGEST_LENGTH, 64};
const EVP_MD kSha1{Algo::SHA1, SHA_DIGEST_LENGTH, 64};
const EVP_MD kSha224{Algo::SHA224, SHA224_DIGEST_LENGTH, 64};
const EVP_MD kSha256{Algo::SHA256, SHA256_DIGEST_LENGTH, 64};
const EVP_MD kSha384{Algo::SHA384, SHA384_DIGEST_LENGTH, 128};
const EVP_MD kSha512{Algo::SHA512, SHA512_DIGEST_LENGTH, 128};

}  // namespace

const EVP_MD* EVP_md5() { return &kMd5; }
const EVP_MD* EVP_sha1() { return &kSha1; }
const EVP_MD* EVP_sha224() { return &kSha224; }
const EVP_MD* EVP_sha256() { return &kSha256; }
const EVP_MD* EVP_sha384() { return &kSha384; }
const EVP_MD* EVP_sha512() { return &kSha512; }

const EVP_MD* EVP_get_digestbyname(const char* name) {
  std::string n;
  for (const char* p = name; p != nullptr && *p != '\0'; p++) {
    if (*p != '-' && *p != '_') n += static_cast<char>(std::tolower(static_cast<unsigned char>(*p)));
  }
  if (n == "md5") return &kMd5;
  if (n == "sha1") return &kSha1;
  if (n == "sha224") return &kSha224;
  if (n == "sha256") return &kSha256;
  if (n == "sha384") return &kSha384;
  if (n == "sha512") return &kSha512;
  return nullptr;
}

int EVP_MD_get_size(const EVP_MD* md) { return md == nullptr ? -1 : md->size; }
int EVP_MD_get_block_size(const EVP_MD* md) { return md == nullptr ? -1 : md->block; }

EVP_MD_CTX* EVP_MD_CTX_new() { return new EVP_MD_CTX(); }
void EVP_MD_CTX_free(EVP_MD_CTX* ctx) { delete ctx; }
int EVP_MD_CTX_reset(EVP_MD_CTX* ctx) {
  ctx->md = nullptr;
  return 1;
}

int EVP_DigestInit_ex(EVP_MD_CTX* ctx, const EVP_MD* type, ENGINE*) {
  if (ctx == nullptr) return 0;
  if (type != nullptr) ctx->md = type;
  if (ctx->md == nullptr) return 0;
  switch (ctx->md->algo) {
    case Algo::MD5: return MD5_Init(&ctx->u.md5);
    case Algo::SHA1: return SHA1_Init(&ctx->u.sha1);
    case Algo::SHA224: return SHA224_Init(&ctx->u.sha256);
    case Algo::SHA256: return SHA256_Init(&ctx->u.sha256);
    case Algo::SHA384: return SHA384_Init(&ctx->u.sha512);
    case Algo::SHA512: return SHA512_Init(&ctx->u.sha512);
  }
  return 0;
}
int EVP_DigestInit(EVP_MD_CTX* ctx, const EVP_MD* type) { return EVP_DigestInit_ex(ctx, type, nullptr); }

int EVP_DigestUpdate(EVP_MD_CTX* ctx, const void* d, size_t cnt) {
  if (ctx == nullptr || ctx->md == nullptr) return 0;
  switch (ctx->md->algo) {
    case Algo::MD5: return MD5_Update(&ctx->u.md5, d, cnt);
    case Algo::SHA1: return SHA1_Update(&ctx->u.sha1, d, cnt);
    case Algo::SHA224:
    case Algo::SHA256: return SHA256_Update(&ctx->u.sha256, d, cnt);
    case Algo::SHA384:
    case Algo::SHA512: return SHA512_Update(&ctx->u.sha512, d, cnt);
  }
  return 0;
}

int EVP_DigestFinal_ex(EVP_MD_CTX* ctx, unsigned char* md, unsigned int* s) {
  if (ctx == nullptr || ctx->md == nullptr) return 0;
  switch (ctx->md->algo) {
    case Algo::MD5: MD5_Final(md, &ctx->u.md5); break;
    case Algo::SHA1: SHA1_Final(md, &ctx->u.sha1); break;
    case Algo::SHA224:
    case Algo::SHA256: SHA256_Final(md, &ctx->u.sha256); break;
    case Algo::SHA384:
    case Algo::SHA512: SHA512_Final(md, &ctx->u.sha512); break;
  }
  if (s != nullptr) *s = static_cast<unsigned int>(ctx->md->size);
  return 1;
}
int EVP_DigestFinal(EVP_MD_CTX* ctx, unsigned char* md, unsigned int* s) { return EVP_DigestFinal_ex(ctx, md, s); }

int EVP_Digest(const void* data, size_t count, unsigned char* md, unsigned int* size, const EVP_MD* type,
               ENGINE* impl) {
  EVP_MD_CTX ctx;
  return EVP_DigestInit_ex(&ctx, type, impl) && EVP_DigestUpdate(&ctx, data, count) &&
         EVP_DigestFinal_ex(&ctx, md, size);
}

namespace {
const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
}

int EVP_EncodeBlock(unsigned char* t, const unsigned char* f, int n) {
  int out = 0;
  for (int i = 0; i < n; i += 3) {
    const uint32_t v = (uint32_t(f[i]) << 16) | (i + 1 < n ? uint32_t(f[i + 1]) << 8 : 0) | (i + 2 < n ? f[i + 2] : 0);
    t[out++] = kB64[(v >> 18) & 63];
    t[out++] = kB64[(v >> 12) & 63];
    t[out++] = i + 1 < n ? kB64[(v >> 6) & 63] : '=';
    t[out++] = i + 2 < n ? kB64[v & 63] : '=';
  }
  t[out] = '\0';
  return out;
}

int EVP_DecodeBlock(unsigned char* t, const unsigned char* f, int n) {
  while (n > 0 && std::isspace(f[n - 1])) n--;
  while (n > 0 && std::isspace(*f)) {
    f++;
    n--;
  }
  if (n % 4 != 0) return -1;
  int out = 0;
  for (int i = 0; i < n; i += 4) {
    uint32_t v = 0;
    for (int j = 0; j < 4; j++) {
      const unsigned char c = f[i + j];
      const char* at = std::strchr(kB64, c);
      int d;
      if (c == '=') d = 0;
      else if (c != '\0' && at != nullptr) d = static_cast<int>(at - kB64);
      else return -1;
      v = (v << 6) | static_cast<uint32_t>(d);
    }
    t[out++] = static_cast<unsigned char>(v >> 16);
    t[out++] = static_cast<unsigned char>(v >> 8);
    t[out++] = static_cast<unsigned char>(v);
  }
  return out;
}

// ---- hmac.h -------------------------------------------------------------------------------------

struct hmac_ctx_st {
  const EVP_MD* md = nullptr;
  EVP_MD_CTX inner;
  EVP_MD_CTX outer;
};

HMAC_CTX* HMAC_CTX_new() { return new HMAC_CTX(); }
void HMAC_CTX_free(HMAC_CTX* ctx) { delete ctx; }
int HMAC_CTX_reset(HMAC_CTX* ctx) {
  ctx->md = nullptr;
  return 1;
}

int HMAC_Init_ex(HMAC_CTX* ctx, const void* key, int key_len, const EVP_MD* md, ENGINE*) {
  if (md != nullptr) ctx->md = md;
  if (ctx->md == nullptr) return 0;
  const int block = ctx->md->block;
  unsigned char k[128] = {};
  if (key_len > block) {
    unsigned int n = 0;
    EVP_Digest(key, static_cast<size_t>(key_len), k, &n, ctx->md, nullptr);
  } else if (key_len > 0) {
    std::memcpy(k, key, static_cast<size_t>(key_len));
  }
  unsigned char ipad[128], opad[128];
  for (int i = 0; i < block; i++) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  EVP_DigestInit_ex(&ctx->inner, ctx->md, nullptr);
  EVP_DigestUpdate(&ctx->inner, ipad, static_cast<size_t>(block));
  EVP_DigestInit_ex(&ctx->outer, ctx->md, nullptr);
  EVP_DigestUpdate(&ctx->outer, opad, static_cast<size_t>(block));
  return 1;
}

int HMAC_Update(HMAC_CTX* ctx, const unsigned char* data, size_t len) {
  return EVP_DigestUpdate(&ctx->inner, data, len);
}

int HMAC_Final(HMAC_CTX* ctx, unsigned char* md, unsigned int* len) {
  unsigned char inner[EVP_MAX_MD_SIZE];
  unsigned int n = 0;
  EVP_DigestFinal_ex(&ctx->inner, inner, &n);
  EVP_DigestUpdate(&ctx->outer, inner, n);
  return EVP_DigestFinal_ex(&ctx->outer, md, len);
}

size_t HMAC_size(const HMAC_CTX* ctx) { return ctx->md == nullptr ? 0 : static_cast<size_t>(ctx->md->size); }

unsigned char* HMAC(const EVP_MD* evp_md, const void* key, int key_len, const unsigned char* data, size_t data_len,
                    unsigned char* md_out, unsigned int* md_len) {
  static unsigned char out[EVP_MAX_MD_SIZE];
  if (md_out == nullptr) md_out = out;
  HMAC_CTX ctx;
  if (!HMAC_Init_ex(&ctx, key, key_len, evp_md, nullptr)) return nullptr;
  HMAC_Update(&ctx, data, data_len);
  HMAC_Final(&ctx, md_out, md_len);
  return md_out;
}

// ---- rand.h -------------------------------------------------------------------------------------

int RAND_bytes(unsigned char* buf, int num) {
  static std::mt19937_64 gen{std::random_device{}()};
  for (int i = 0; i < num; i++) buf[i] = static_cast<unsigned char>(gen());
  return 1;
}
int RAND_priv_bytes(unsigned char* buf, int num) { return RAND_bytes(buf, num); }
int RAND_status() { return 1; }

// ---- err.h --------------------------------------------------------------------------------------

unsigned long ERR_get_error() { return 0; }
unsigned long ERR_peek_error() { return 0; }
void ERR_clear_error() {}
char* ERR_error_string(unsigned long e, char* buf) {
  static char out[256];
  if (buf == nullptr) buf = out;
  std::snprintf(buf, 256, "error:%08lX:lib(0)::reason(0)", e);
  return buf;
}
void ERR_error_string_n(unsigned long e, char* buf, size_t len) {
  if (len == 0) return;
  std::snprintf(buf, len, "error:%08lX:lib(0)::reason(0)", e);
}
void ERR_print_errors_fp(FILE*) {}

// ---- ssl.h --------------------------------------------------------------------------------------

struct ssl_method_st {
  bool server;
  bool client;
};

namespace {
const SSL_METHOD kAny{true, true};
const SSL_METHOD kServer{true, false};
const SSL_METHOD kClient{false, true};

void copy_into(char (&field)[512], const char* value) {
  std::snprintf(field, sizeof field, "%s", value == nullptr ? "" : value);
}
}  // namespace

const SSL_METHOD* TLS_method() { return &kAny; }
const SSL_METHOD* TLS_server_method() { return &kServer; }
const SSL_METHOD* TLS_client_method() { return &kClient; }

int OPENSSL_init_ssl(uint64_t, const void*) { return 1; }

SSL_CTX* SSL_CTX_new(const SSL_METHOD* method) {
  auto* ctx = new SSL_CTX();
  ctx->server = method == nullptr || method->server;
  return ctx;
}
void SSL_CTX_free(SSL_CTX* ctx) { delete ctx; }

namespace {
bool known_version(int version) { return version == 0 || (version >= SSL3_VERSION && version <= TLS1_3_VERSION); }
}  // namespace

int SSL_CTX_set_min_proto_version(SSL_CTX* ctx, int version) {
  if (ctx == nullptr || !known_version(version)) return 0;
  ctx->min_proto_version = version;
  return 1;
}
int SSL_CTX_set_max_proto_version(SSL_CTX* ctx, int version) {
  if (ctx == nullptr || !known_version(version)) return 0;
  ctx->max_proto_version = version;
  return 1;
}
int SSL_CTX_get_min_proto_version(SSL_CTX* ctx) { return ctx == nullptr ? 0 : ctx->min_proto_version; }
int SSL_CTX_get_max_proto_version(SSL_CTX* ctx) { return ctx == nullptr ? 0 : ctx->max_proto_version; }
uint64_t SSL_CTX_set_options(SSL_CTX* ctx, uint64_t op) { return ctx->options |= op; }
uint64_t SSL_CTX_clear_options(SSL_CTX* ctx, uint64_t op) { return ctx->options &= ~op; }
uint64_t SSL_CTX_get_options(const SSL_CTX* ctx) { return ctx->options; }
int SSL_CTX_set_cipher_list(SSL_CTX* ctx, const char* str) {
  copy_into(ctx->cipher_list, str);
  return 1;
}
int SSL_CTX_set_ciphersuites(SSL_CTX* ctx, const char* str) {
  copy_into(ctx->ciphersuites, str);
  return 1;
}
void SSL_CTX_set_verify(SSL_CTX* ctx, int mode, int (*)(int, void*)) { ctx->verify_mode = mode; }
int SSL_CTX_use_certificate_chain_file(SSL_CTX* ctx, const char* file) {
  copy_into(ctx->certificate_file, file);
  return 1;
}
int SSL_CTX_use_certificate_file(SSL_CTX* ctx, const char* file, int) {
  copy_into(ctx->certificate_file, file);
  return 1;
}
int SSL_CTX_use_PrivateKey_file(SSL_CTX* ctx, const char* file, int) {
  copy_into(ctx->private_key_file, file);
  return 1;
}
int SSL_CTX_check_private_key(const SSL_CTX*) { return 1; }
int SSL_CTX_load_verify_locations(SSL_CTX*, const char*, const char*) { return 1; }
int SSL_CTX_set_default_verify_paths(SSL_CTX*) { return 1; }

// ---- crypto/sha256.h ----------------------------------------------------------------------------

namespace lb::crypto {

// Declared in crypto/sha256.h (not included here: its SHA256 is a class, OpenSSL's a function).
void sha256_init(void* state);
void sha256_update(void* state, const unsigned char* data, size_t len);
void sha256_final(void* state, unsigned char* hash);

static_assert(sizeof(SHA256_CTX) <= 128, "crypto/sha256.h's state holds a SHA256_CTX");

void sha256_init(void* state) { SHA256_Init(static_cast<SHA256_CTX*>(state)); }
void sha256_update(void* state, const unsigned char* data, size_t len) {
  SHA256_Update(static_cast<SHA256_CTX*>(state), data, len);
}
void sha256_final(void* state, unsigned char* hash) { SHA256_Final(hash, static_cast<SHA256_CTX*>(state)); }

}  // namespace lb::crypto
