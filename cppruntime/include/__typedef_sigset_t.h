// sigset_t for the LeetBuild C++ runtime's signals (cppruntime/src/signal.cpp). wasi-libc's own is a
// one-byte placeholder (`typedef unsigned char sigset_t;`), too small for SIGTERM (15); this header
// comes first on the include path and keeps its guard, so <signal.h> gets 64 bits, one per signal.
// No function of wasi-libc takes a sigset_t: the runtime defines every one that does.
#ifndef __wasilibc___typedef_sigset_t_h
#define __wasilibc___typedef_sigset_t_h

typedef unsigned long long sigset_t;

#endif
