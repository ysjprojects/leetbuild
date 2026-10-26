// POSIX signals for the LeetBuild C++ runtime. WebAssembly has none, and wasi-libc only declares
// them (-D_WASI_EMULATED_SIGNAL); these definitions are what a program's signal(), sigaction(),
// pthread_sigmask() and sigwait() run on. A signal comes from the harness (Program::Signal, the
// way a container runtime sends SIGTERM) or from raise()/kill(): a thread waiting in sigwait() for
// it receives it; else a handler installed with signal()/sigaction() runs on a thread of its own
// (it interrupts nothing, as a Go signal channel would); else SIGTERM, SIGINT, SIGHUP and SIGQUIT
// end the program (exit status 128 + the signal) and the rest are dropped. One mask for the whole
// process: a blocked signal stays pending until a sigwait() takes it.
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <time.h>

#include <lb/runtime.h>

namespace {

constexpr int kSignals = 64;

using Handler = void (*)(int);

struct State {
  Handler handlers[kSignals + 1] = {};
  sigset_t blocked = 0;
  sigset_t pending = 0;
  // Threads in sigwait(), each with the set it waits for and where its signal goes.
  struct Waiter {
    sigset_t set;
    int* sig;
    lb::WaitQueue* queue;
  };
  std::vector<Waiter> waiters;
};

State& state() {
  static State s;
  return s;
}

bool valid(int sig) { return sig > 0 && sig <= kSignals; }

sigset_t bit(int sig) { return 1ULL << (sig - 1); }

// What the default action does: end the program for the terminating signals, nothing for the rest.
void default_action(int sig) {
  if (sig == SIGTERM || sig == SIGINT || sig == SIGHUP || sig == SIGQUIT) exit(128 + sig);
}

// Hand sig to a waiter whose set has it; whether one took it.
bool to_waiter(int sig) {
  auto& waiters = state().waiters;
  for (auto it = waiters.begin(); it != waiters.end(); ++it) {
    if ((it->set & bit(sig)) != 0) {
      *it->sig = sig;
      lb::WaitQueue* queue = it->queue;
      waiters.erase(it);
      queue->notify_all();
      return true;
    }
  }
  return false;
}

}  // namespace

extern "C" {

void __SIG_IGN(int) {}
void __SIG_ERR(int) {}

Handler signal(int sig, Handler handler) {
  if (!valid(sig) || sig == SIGKILL || sig == SIGSTOP) {
    errno = EINVAL;
    return SIG_ERR;
  }
  Handler old = state().handlers[sig];
  state().handlers[sig] = handler;
  return old;
}

Handler bsd_signal(int sig, Handler handler) { return signal(sig, handler); }

int sigaction(int sig, const struct sigaction* __restrict act, struct sigaction* __restrict old) {
  if (!valid(sig)) {
    errno = EINVAL;
    return -1;
  }
  if (old != nullptr) {
    *old = {};
    old->sa_handler = state().handlers[sig];
  }
  if (act != nullptr) state().handlers[sig] = act->sa_handler;
  return 0;
}

int sigemptyset(sigset_t* set) {
  *set = 0;
  return 0;
}

int sigfillset(sigset_t* set) {
  *set = ~0ULL;
  return 0;
}

int sigaddset(sigset_t* set, int sig) {
  if (!valid(sig)) {
    errno = EINVAL;
    return -1;
  }
  *set |= bit(sig);
  return 0;
}

int sigdelset(sigset_t* set, int sig) {
  if (!valid(sig)) {
    errno = EINVAL;
    return -1;
  }
  *set &= ~bit(sig);
  return 0;
}

int sigismember(const sigset_t* set, int sig) { return valid(sig) && (*set & bit(sig)) != 0 ? 1 : 0; }

int sigisemptyset(const sigset_t* set) { return *set == 0 ? 1 : 0; }

int sigprocmask(int how, const sigset_t* __restrict set, sigset_t* __restrict old) {
  State& s = state();
  if (old != nullptr) *old = s.blocked;
  if (set == nullptr) return 0;
  switch (how) {
    case SIG_BLOCK: s.blocked |= *set; break;
    case SIG_UNBLOCK: s.blocked &= ~*set; break;
    case SIG_SETMASK: s.blocked = *set; break;
    default: errno = EINVAL; return -1;
  }
  return 0;
}

int pthread_sigmask(int how, const sigset_t* __restrict set, sigset_t* __restrict old) {
  return sigprocmask(how, set, old) == 0 ? 0 : errno;
}

int sigpending(sigset_t* set) {
  *set = state().pending;
  return 0;
}

// Wait for a signal of `set` (a pending one at once); its number, or -1 (EAGAIN) once `ms` passed.
static int wait_for(const sigset_t* set, double ms) {
  State& s = state();
  for (int sig = 1; sig <= kSignals; sig++) {
    if ((s.pending & *set & bit(sig)) != 0) {
      s.pending &= ~bit(sig);
      return sig;
    }
  }
  int received = 0;
  lb::WaitQueue queue;
  s.waiters.push_back({*set, &received, &queue});
  queue.wait(ms);
  if (received == 0) {
    for (auto it = s.waiters.begin(); it != s.waiters.end(); ++it) {
      if (it->queue == &queue) {
        s.waiters.erase(it);
        break;
      }
    }
    errno = EAGAIN;
    return -1;
  }
  return received;
}

int sigwait(const sigset_t* __restrict set, int* __restrict sig) {
  *sig = wait_for(set, -1);
  return 0;
}

int sigwaitinfo(const sigset_t* __restrict set, siginfo_t* __restrict info) {
  const int sig = wait_for(set, -1);
  if (info != nullptr) {
    *info = {};
    info->si_signo = sig;
  }
  return sig;
}

int sigtimedwait(const sigset_t* __restrict set, siginfo_t* __restrict info, const struct timespec* __restrict timeout) {
  const double ms = timeout == nullptr ? -1 : static_cast<double>(timeout->tv_sec) * 1000.0 + timeout->tv_nsec / 1e6;
  const int sig = wait_for(set, ms);
  if (sig > 0 && info != nullptr) {
    *info = {};
    info->si_signo = sig;
  }
  return sig;
}

// Wait, with `mask` as the mask, for a signal: its handler (or default action) runs here; EINTR.
int sigsuspend(const sigset_t* mask) {
  const sigset_t wanted = ~*mask;
  const int sig = wait_for(&wanted, -1);
  const Handler handler = state().handlers[sig];
  if (handler == SIG_DFL) {
    default_action(sig);
  } else if (handler != SIG_IGN) {
    handler(sig);
  }
  errno = EINTR;
  return -1;
}

int pause(void) {
  const sigset_t none = 0;
  return sigsuspend(&none);
}

// One process: whatever pid it names, the signal is the program's own.
int kill(pid_t, int sig) {
  if (sig == 0) return 0;
  if (!valid(sig)) {
    errno = EINVAL;
    return -1;
  }
  lb::deliver_signal(sig);
  return 0;
}

int raise(int sig) {
  if (!valid(sig)) {
    errno = EINVAL;
    return -1;
  }
  lb::deliver_signal(sig);
  return 0;
}

}  // extern "C"

namespace lb {

int deliver_signal(int sig) {
  if (!valid(sig)) return 0;
  State& s = state();
  if (to_waiter(sig)) return 1;
  if ((s.blocked & bit(sig)) != 0) {
    s.pending |= bit(sig);
    return 1;
  }
  const Handler handler = s.handlers[sig];
  if (handler == SIG_IGN) return 0;
  if (handler == SIG_DFL) {
    if (sig == SIGTERM || sig == SIGINT || sig == SIGHUP || sig == SIGQUIT) {
      spawn([sig] { default_action(sig); });
      return 1;
    }
    return 0;
  }
  spawn([handler, sig] { handler(sig); });
  return 1;
}

}  // namespace lb
