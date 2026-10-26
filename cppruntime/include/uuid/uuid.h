// libuuid's <uuid/uuid.h>, as the LeetBuild C++ runtime models it: random (version 4) UUIDs and
// their text form (cppruntime/src/uuid.cpp).
#pragma once

typedef unsigned char uuid_t[16];

void uuid_generate(uuid_t out);
void uuid_generate_random(uuid_t out);
// Time-based UUIDs are random ones here (the runtime has no MAC address).
void uuid_generate_time(uuid_t out);
// 36 characters and a NUL into out, lower-case (uuid_unparse_upper: upper-case).
void uuid_unparse(const uuid_t uu, char* out);
void uuid_unparse_lower(const uuid_t uu, char* out);
void uuid_unparse_upper(const uuid_t uu, char* out);
// 0 when in is a UUID's text form, -1 otherwise.
int uuid_parse(const char* in, uuid_t uu);
void uuid_clear(uuid_t uu);
int uuid_is_null(const uuid_t uu);
int uuid_compare(const uuid_t uu1, const uuid_t uu2);
void uuid_copy(uuid_t dst, const uuid_t src);
