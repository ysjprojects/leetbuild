// OpenSSL's <openssl/rand.h>, as the LeetBuild C++ runtime models it (cppruntime/src/openssl.cpp).
#pragma once

// num random bytes into buf; 1.
int RAND_bytes(unsigned char* buf, int num);
int RAND_priv_bytes(unsigned char* buf, int num);
int RAND_status();
