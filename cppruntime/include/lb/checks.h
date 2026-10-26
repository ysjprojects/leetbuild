// What every program the runtime compiles ends with (src/lib/runtime/cpp.ts generates the
// translation unit: the learner's file, the harness, this, then LB_CHECKS(...) naming the checks in
// order): the entry points the JavaScript side calls. They are defined in the program itself — an
// export in a library member would be dropped unless something referenced it — and call into the
// runtime (libleetbuild.a), whose pthreads the program's threads run on.
#pragma once

#include <leetbuild/harness.h>

namespace lb {

using CheckFn = void (*)(harness::Ctx&);

// Run one check with a fresh Ctx; a failure (or anything thrown) is reported as its verdict.
void run_check(CheckFn fn);

}  // namespace lb

#define LB_CHECKS(...)                                                                                     \
  extern "C" __attribute__((export_name("lb_check"))) void lb_check(int index) {                         \
    static const lb::CheckFn checks[] = {__VA_ARGS__};                                                   \
    lb::run_check(checks[index]);                                                                        \
  }                                                                                                      \
  extern "C" __attribute__((export_name("lb_thread_main"))) void lb_thread_main(void* task) {            \
    lb::thread_main(task);                                                                               \
  }                                                                                                      \
  extern "C" __attribute__((export_name("lb_invoke"))) void lb_invoke(int handle) { lb::invoke(handle); } \
  extern "C" __attribute__((export_name("lb_deliver"))) void lb_deliver(int handle, char* data, int size) { \
    lb::deliver(handle, data, size);                                                                     \
  }                                                                                                      \
  extern "C" __attribute__((export_name("lb_eh_globals"))) void* lb_eh_globals() { return lb::eh_globals(); }
