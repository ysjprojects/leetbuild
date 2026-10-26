// <signal.h> for the LeetBuild C++ runtime: wasi-libc's (signal numbers, signal(), raise(),
// SIG_DFL/SIG_IGN) plus the POSIX signal API it leaves out because WASI has no signals — signal
// sets, sigaction, the masks, sigwait, kill — which cppruntime/src/signal.cpp defines on the
// runtime's green threads. Found before the sysroot's (the runtime's include path comes first).
#ifndef LB_SIGNAL_H
#define LB_SIGNAL_H

#include_next <signal.h>

#include <__typedef_sigset_t.h>
#include <sys/types.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2

#define SA_NOCLDSTOP 1
#define SA_NOCLDWAIT 2
#define SA_SIGINFO 4
#define SA_ONSTACK 0x08000000
#define SA_RESTART 0x10000000
#define SA_NODEFER 0x40000000
#define SA_RESETHAND 0x80000000

union sigval {
  int sival_int;
  void* sival_ptr;
};

typedef struct {
  int si_signo;
  int si_errno;
  int si_code;
  pid_t si_pid;
  union sigval si_value;
} siginfo_t;

struct sigaction {
  union {
    void (*sa_handler)(int);
    void (*sa_sigaction)(int, siginfo_t*, void*);
  } __sa_handler;
  sigset_t sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};
#define sa_handler __sa_handler.sa_handler
#define sa_sigaction __sa_handler.sa_sigaction

int kill(pid_t, int);

int sigemptyset(sigset_t*);
int sigfillset(sigset_t*);
int sigaddset(sigset_t*, int);
int sigdelset(sigset_t*, int);
int sigismember(const sigset_t*, int);
int sigisemptyset(const sigset_t*);

int sigprocmask(int, const sigset_t* __restrict, sigset_t* __restrict);
int pthread_sigmask(int, const sigset_t* __restrict, sigset_t* __restrict);
int sigsuspend(const sigset_t*);
int sigaction(int, const struct sigaction* __restrict, struct sigaction* __restrict);
int sigpending(sigset_t*);
int sigwait(const sigset_t* __restrict, int* __restrict);
int sigwaitinfo(const sigset_t* __restrict, siginfo_t* __restrict);
int sigtimedwait(const sigset_t* __restrict, siginfo_t* __restrict, const struct timespec* __restrict);

#ifdef __cplusplus
}
#endif

#endif
