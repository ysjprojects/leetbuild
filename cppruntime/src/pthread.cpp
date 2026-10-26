// POSIX threads on the runtime's green threads, for libc++: std::thread, std::mutex,
// std::condition_variable, std::future and the rest call these. wasi-libc's own versions are stubs
// for a single-threaded program (pthread_create fails); these definitions take their place at link
// time (libleetbuild.a comes before libc on the link line). A mutex or condition variable keeps its
// state in its own bytes — zero is unlocked, no waiters — with the threads waiting on it in a
// queue of the runtime's.
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <time.h>

#include <map>
#include <vector>

#include <lb/runtime.h>

namespace lb::pthread {

// Wait queues by index + 1 (0 in a mutex or condition variable: none yet).
inline std::vector<WaitQueue*>& queues() {
  static std::vector<WaitQueue*> all;
  return all;
}

inline WaitQueue& queue_at(int& slot) {
  if (slot == 0) {
    queues().push_back(new WaitQueue());
    slot = static_cast<int>(queues().size());
  }
  return *queues()[slot - 1];
}

inline void free_queue(int& slot) {
  if (slot != 0) {
    delete queues()[slot - 1];
    queues()[slot - 1] = nullptr;
    slot = 0;
  }
}

// A mutex's bytes: its type, owner (0: unlocked), lock count, wait queue.
inline int& type_of(pthread_mutex_t* m) { return m->__u.__i[0]; }
inline int& owner_of(pthread_mutex_t* m) { return m->__u.__i[1]; }
inline int& count_of(pthread_mutex_t* m) { return m->__u.__i[2]; }
inline int& queue_of(pthread_mutex_t* m) { return m->__u.__i[3]; }
inline int& queue_of(pthread_cond_t* c) { return c->__u.__i[0]; }

constexpr int kRecursive = 1;

// Virtual milliseconds from now until an absolute time on the clock (CLOCK_REALTIME and the
// monotonic clock read the same virtual time here).
inline double ms_until(const struct timespec* at) {
  return (static_cast<double>(at->tv_sec) * 1000.0 + static_cast<double>(at->tv_nsec) / 1e6) - lb_now();
}

inline int lock(pthread_mutex_t* m, double timeout_ms) {
  const int self = lb_self();
  if (owner_of(m) == self) {
    if (type_of(m) != kRecursive) return EDEADLK;
    count_of(m) += 1;
    return 0;
  }
  while (owner_of(m) != 0) {
    if (timeout_ms < 0) {
      queue_at(queue_of(m)).wait();
    } else if (!queue_at(queue_of(m)).wait(timeout_ms)) {
      if (owner_of(m) != 0) return ETIMEDOUT;
    }
  }
  owner_of(m) = self;
  count_of(m) = 1;
  return 0;
}

inline int unlock(pthread_mutex_t* m) {
  if (owner_of(m) != lb_self()) return EPERM;
  if (--count_of(m) > 0) return 0;
  owner_of(m) = 0;
  if (queue_of(m) != 0) queue_at(queue_of(m)).notify_one();
  return 0;
}

// A thread pthread_create started, until joined (or, detached, until it ends).
struct Thread {
  void* (*fn)(void*);
  void* arg;
  void* result = nullptr;
  bool done = false;
  bool detached = false;
  WaitQueue joiners;
};

inline std::map<int, Thread*>& threads() {
  static std::map<int, Thread*> all;
  return all;
}

// Thread-specific data: per thread, per key. libc++abi keeps the exceptions in flight here.
struct Keys {
  std::vector<void (*)(void*)> destructors;
  std::vector<bool> used;
  std::map<std::pair<int, pthread_key_t>, void*> values;
};

inline Keys& keys() {
  static Keys k;
  return k;
}

// Run the thread's key destructors (POSIX: up to PTHREAD_DESTRUCTOR_ITERATIONS rounds).
inline void run_destructors(int thread) {
  Keys& k = keys();
  for (int round = 0; round < 4; round++) {
    bool any = false;
    for (pthread_key_t key = 0; key < k.destructors.size(); key++) {
      auto it = k.values.find({thread, key});
      if (it == k.values.end()) continue;
      void* value = it->second;
      k.values.erase(it);
      if (value != nullptr && k.used[key] && k.destructors[key] != nullptr) {
        k.destructors[key](value);
        any = true;
      }
    }
    if (!any) return;
  }
}

}  // namespace lb::pthread

extern "C" {

int pthread_create(pthread_t* __restrict out, const pthread_attr_t* __restrict attr, void* (*fn)(void*),
                   void* __restrict arg) {
  using lb::pthread::Thread;
  auto* t = new Thread{fn, arg};
  int detach = PTHREAD_CREATE_JOINABLE;
  if (attr != nullptr) pthread_attr_getdetachstate(attr, &detach);
  t->detached = detach == PTHREAD_CREATE_DETACHED;
  auto* task = new lb::Task{[t] {
    const int self = lb_self();
    t->result = t->fn(t->arg);
    lb::pthread::run_destructors(self);
    t->done = true;
    t->joiners.notify_all();
    if (t->detached) {
      lb::pthread::threads().erase(self);
      delete t;
    }
  }};
  const int id = lb_spawn(task);
  lb::pthread::threads()[id] = t;
  *out = static_cast<pthread_t>(id);
  return 0;
}

int pthread_join(pthread_t id, void** result) {
  auto& all = lb::pthread::threads();
  auto it = all.find(static_cast<int>(id));
  if (it == all.end()) return ESRCH;
  if (static_cast<int>(id) == lb_self()) return EDEADLK;
  lb::pthread::Thread* t = it->second;
  while (!t->done) t->joiners.wait();
  if (result != nullptr) *result = t->result;
  all.erase(static_cast<int>(id));
  delete t;
  return 0;
}

int pthread_detach(pthread_t id) {
  auto& all = lb::pthread::threads();
  auto it = all.find(static_cast<int>(id));
  if (it == all.end()) return ESRCH;
  if (it->second->done) {
    delete it->second;
    all.erase(it);
  } else {
    it->second->detached = true;
  }
  return 0;
}

pthread_t pthread_self(void) { return static_cast<pthread_t>(lb_self()); }

int sched_yield(void) {
  lb_yield();
  return 0;
}

int pthread_once(pthread_once_t* once, void (*fn)(void)) {
  if (*once == 0) {
    *once = 1;
    fn();
    *once = 2;
  }
  while (*once == 1) lb_yield();
  return 0;
}

int pthread_mutex_init(pthread_mutex_t* __restrict m, const pthread_mutexattr_t* __restrict attr) {
  *m = pthread_mutex_t{};
  lb::pthread::type_of(m) = attr == nullptr ? 0 : static_cast<int>(attr->__attr & 3);
  return 0;
}

int pthread_mutex_destroy(pthread_mutex_t* m) {
  lb::pthread::free_queue(lb::pthread::queue_of(m));
  return 0;
}

int pthread_mutex_lock(pthread_mutex_t* m) { return lb::pthread::lock(m, -1); }

int pthread_mutex_timedlock(pthread_mutex_t* __restrict m, const struct timespec* __restrict at) {
  const double ms = lb::pthread::ms_until(at);
  return lb::pthread::lock(m, ms < 0 ? 0 : ms);
}

int pthread_mutex_trylock(pthread_mutex_t* m) {
  using namespace lb::pthread;
  const int self = lb_self();
  if (owner_of(m) == 0) {
    owner_of(m) = self;
    count_of(m) = 1;
    return 0;
  }
  if (owner_of(m) == self && type_of(m) == kRecursive) {
    count_of(m) += 1;
    return 0;
  }
  return EBUSY;
}

int pthread_mutex_unlock(pthread_mutex_t* m) { return lb::pthread::unlock(m); }

int pthread_cond_init(pthread_cond_t* __restrict c, const pthread_condattr_t* __restrict) {
  *c = pthread_cond_t{};
  return 0;
}

int pthread_cond_destroy(pthread_cond_t* c) {
  lb::pthread::free_queue(lb::pthread::queue_of(c));
  return 0;
}

int pthread_cond_wait(pthread_cond_t* __restrict c, pthread_mutex_t* __restrict m) {
  lb::WaitQueue& q = lb::pthread::queue_at(lb::pthread::queue_of(c));
  lb::pthread::unlock(m);
  q.wait();
  return lb::pthread::lock(m, -1);
}

int pthread_cond_timedwait(pthread_cond_t* __restrict c, pthread_mutex_t* __restrict m,
                           const struct timespec* __restrict at) {
  const double ms = lb::pthread::ms_until(at);
  if (ms <= 0) return ETIMEDOUT;
  lb::WaitQueue& q = lb::pthread::queue_at(lb::pthread::queue_of(c));
  lb::pthread::unlock(m);
  const bool woken = q.wait(ms);
  lb::pthread::lock(m, -1);
  return woken ? 0 : ETIMEDOUT;
}

int pthread_cond_signal(pthread_cond_t* c) {
  if (lb::pthread::queue_of(c) != 0) lb::pthread::queue_at(lb::pthread::queue_of(c)).notify_one();
  return 0;
}

int pthread_cond_broadcast(pthread_cond_t* c) {
  if (lb::pthread::queue_of(c) != 0) lb::pthread::queue_at(lb::pthread::queue_of(c)).notify_all();
  return 0;
}

int pthread_key_create(pthread_key_t* key, void (*destructor)(void*)) {
  auto& k = lb::pthread::keys();
  *key = static_cast<pthread_key_t>(k.destructors.size());
  k.destructors.push_back(destructor);
  k.used.push_back(true);
  return 0;
}

int pthread_key_delete(pthread_key_t key) {
  auto& k = lb::pthread::keys();
  if (key >= k.used.size()) return EINVAL;
  k.used[key] = false;
  return 0;
}

void* pthread_getspecific(pthread_key_t key) {
  auto& values = lb::pthread::keys().values;
  auto it = values.find({lb_self(), key});
  return it == values.end() ? nullptr : it->second;
}

int pthread_setspecific(pthread_key_t key, const void* value) {
  lb::pthread::keys().values[{lb_self(), key}] = const_cast<void*>(value);
  return 0;
}

}  // extern "C"
