// The LeetBuild C++ runtime's core: the bridge to the JavaScript half of the world, green threads,
// waits, and the JSON the bridge speaks. The learner's program runs compiled to WebAssembly in one
// thread of the browser (or Node); its threads are green threads that the JavaScript scheduler
// switches between at every blocking call (JSPI), each on its own stack. Time is the runtime's
// virtual clock: a sleep costs nothing, and the harness moves time when it advances it.
// Implemented in cppruntime/src (libleetbuild.a): a program compiles only what it instantiates.
#pragma once

#include <cstddef>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#define LB_IMPORT(name) __attribute__((import_module("lb"), import_name(#name)))

extern "C" {
// Green threads: start one running lb_thread_main(task) (its id); the running one's id; suspend
// until unparked; let others run.
LB_IMPORT(spawn) int lb_spawn(void* task);
LB_IMPORT(self) int lb_self();
LB_IMPORT(park) void lb_park(int token);
// Suspend until unparked or `ms` of virtual time passed; returns 1 when unparked, 0 on timeout.
LB_IMPORT(park_for) int lb_park_for(int token, double ms);
// Wake the thread parked on token: 1, or 0 when none is (its wait timed out already).
LB_IMPORT(unpark) int lb_unpark(int token);
LB_IMPORT(yield) void lb_yield();
// Virtual time, in milliseconds since the epoch, and a sleep on it.
LB_IMPORT(now) double lb_now();
LB_IMPORT(sleep) void lb_sleep(double ms);
// The harness's view of the world: suspend until every other thread waits (settle: and every
// sleep due has run; tick: the clock held where it is).
LB_IMPORT(settle) void lb_settle();
LB_IMPORT(tick) void lb_tick();
// A request to the JavaScript side (op and JSON request); the reply's length, then its bytes.
LB_IMPORT(call) int lb_call(const char* op, int op_len, const char* request, int request_len);
LB_IMPORT(call_async) int lb_call_async(const char* op, int op_len, const char* request, int request_len);
LB_IMPORT(reply) void lb_reply(char* into);
}

namespace lb {

// ---- JSON: the bridge's messages ---------------------------------------------------------------

class Json {
 public:
  enum class Kind { Null, Bool, Number, String, Array, Object };

  Json() = default;
  Json(std::nullptr_t) {}
  Json(bool b) : kind_(Kind::Bool), bool_(b) {}
  Json(int n) : kind_(Kind::Number), number_(n) {}
  Json(long n) : kind_(Kind::Number), number_(static_cast<double>(n)) {}
  Json(long long n) : kind_(Kind::Number), number_(static_cast<double>(n)) {}
  Json(unsigned n) : kind_(Kind::Number), number_(n) {}
  Json(unsigned long n) : kind_(Kind::Number), number_(static_cast<double>(n)) {}
  Json(unsigned long long n) : kind_(Kind::Number), number_(static_cast<double>(n)) {}
  Json(double n) : kind_(Kind::Number), number_(n) {}
  Json(const char* s) : kind_(Kind::String), string_(s) {}
  Json(std::string s) : kind_(Kind::String), string_(std::move(s)) {}
  Json(std::vector<Json> a);
  Json(std::map<std::string, Json> o);

  static Json array();
  static Json object();

  Kind kind() const { return kind_; }
  bool is_null() const { return kind_ == Kind::Null; }
  bool is_bool() const { return kind_ == Kind::Bool; }
  bool is_string() const { return kind_ == Kind::String; }
  bool is_number() const { return kind_ == Kind::Number; }
  bool is_array() const { return kind_ == Kind::Array; }
  bool is_object() const { return kind_ == Kind::Object; }
  bool as_bool() const { return kind_ == Kind::Bool ? bool_ : kind_ == Kind::Number && number_ != 0; }
  double as_number() const { return kind_ == Kind::Number ? number_ : kind_ == Kind::Bool ? bool_ : 0; }
  long long as_int() const { return static_cast<long long>(as_number()); }
  const std::string& as_string() const { return string_; }
  const std::vector<Json>& items() const;
  const std::map<std::string, Json>& fields() const;
  size_t size() const;
  const Json& operator[](size_t i) const;
  // An index literal (`j[0]`) is an int: exactly this, not the null pointer `const char*` would also take.
  const Json& operator[](int i) const { return (*this)[static_cast<size_t>(i)]; }
  const Json& operator[](const std::string& key) const;
  const Json& operator[](const char* key) const { return (*this)[std::string(key)]; }
  bool has(const std::string& key) const;
  void push(Json v);
  void set(const std::string& key, Json v);

  std::string dump() const;
  static Json parse(const std::string& text);

 private:
  Kind kind_ = Kind::Null;
  bool bool_ = false;
  double number_ = 0;
  std::string string_;
  std::shared_ptr<std::vector<Json>> array_;
  std::shared_ptr<std::map<std::string, Json>> object_;
};

// ---- the bridge --------------------------------------------------------------------------------

// A synchronous request to the JavaScript side.
Json call(const std::string& op, const Json& request = Json());

// A request the JavaScript side answers asynchronously (a database statement): this thread waits.
Json call_async(const std::string& op, const Json& request = Json());

// ---- green threads -----------------------------------------------------------------------------

struct Task {
  std::function<void()> run;
};

// Start fn on a green thread of its own; its id. An exception escaping it fails the check, as an
// uncaught exception in a std::thread terminates a real program.
int spawn(std::function<void()> fn);

// Threads waiting on something, woken in the order they began to wait.
class WaitQueue {
 public:
  // Wait until notified (true) or, with a timeout, until `ms` of virtual time passed (false).
  bool wait(double ms = -1);
  // Wake the longest waiting thread; a waiter whose timeout already ended its wait does not count.
  bool notify_one();
  void notify_all();
  bool empty() const { return waiters_.empty(); }

 private:
  std::vector<int> waiters_;
};

// Functions the JavaScript side calls back: synchronously (a Redis probe firing inside a command)
// or on a thread of their own with a payload (a published message). Each returns its handle.
int invocable(std::function<void()> fn);
int receiver(std::function<void(const std::string&)> fn);

// The entry points the program exports (lb/checks.h wires them): run a spawned task, a callback,
// a delivery; and where libc++abi keeps the exceptions in flight (one struct for the whole
// program here, which the scheduler saves and restores as it switches threads).
void thread_main(void* task);
void invoke(int handle);
void deliver(int handle, char* data, int size);
void* eh_globals();

// Send `sig` to the program (cppruntime/src/signal.cpp): to a thread in sigwait(), else to its
// handler on a thread of its own, else the default action. How many received it (0: ignored).
int deliver_signal(int sig);

}  // namespace lb
