// OpenSSL's <openssl/err.h>, as the LeetBuild C++ runtime models it: the error queue stays empty.
#pragma once

#include <cstddef>
#include <cstdio>

unsigned long ERR_get_error();
unsigned long ERR_peek_error();
void ERR_clear_error();
char* ERR_error_string(unsigned long e, char* buf);
void ERR_error_string_n(unsigned long e, char* buf, size_t len);
void ERR_print_errors_fp(FILE* fp);
