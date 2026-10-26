/**
 * How the C++ runtime compiles: the same flags for the runtime's library (`yarn build:cpp`) and
 * for every program the runtime builds, since objects built with different flags do not link (wasm
 * exceptions) or do not agree (the standard library's configuration). The sysroot is mounted at
 * /sysroot, the runtime's pack (cppruntime/include, libleetbuild.a) at /lb.
 */

/**
 * The sysroot's libc++, built with C++ exceptions, comes before the rest of the sysroot; the
 * runtime's headers before both (models, and the sigset_t its signals need). Signals: wasi-libc
 * declares them only on request, and the runtime defines them (cppruntime/src/signal.cpp).
 * _GNU_SOURCE, as g++ and clang++ define it for C++ on Linux, where the course code is written
 * for: it exposes the POSIX and GNU declarations (pthread_sigmask, strndup, M_PI…).
 */
export const COMPILE_FLAGS = [
  '--target=wasm32-wasip1',
  '--sysroot=/sysroot',
  '-nostdinc++',
  '-isystem',
  '/lb/include',
  '-isystem',
  '/sysroot/include/wasm32-wasip1/eh/c++/v1',
  '-std=c++20',
  '-O1',
  '-fwasm-exceptions',
  '-mllvm',
  '-wasm-use-legacy-eh=false',
  '-D_WASI_EMULATED_SIGNAL',
  '-D_WASI_EMULATED_GETPID',
  '-D_WASI_EMULATED_PROCESS_CLOCKS',
  '-D_GNU_SOURCE',
  '-fno-color-diagnostics',
];

/**
 * A reactor (static constructors run by `_initialize`, no `_start`), libleetbuild.a ahead of libc
 * (its pthreads take the place of wasi-libc's single-threaded stubs), the stack pointer and the
 * allocator exported for the scheduler, which gives every green thread a stack of its own.
 */
export const LINK_FLAGS = [
  '-mexec-model=reactor',
  '-L/lb/lib',
  '-L/sysroot/lib/wasm32-wasip1/eh',
  '-lleetbuild',
  '-lunwind',
  // getpid() and clock()/times() as wasi-libc emulates them (WASI has neither).
  '-lwasi-emulated-getpid',
  '-lwasi-emulated-process-clocks',
  '-Wl,-z,stack-size=1048576',
  '-Wl,--export=__stack_pointer',
  '-Wl,--export=malloc',
  '-Wl,--export=free',
];
