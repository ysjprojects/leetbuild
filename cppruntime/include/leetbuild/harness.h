// The C++ harness: what a step's checks (`void CheckTakeOne(harness::Ctx& ctx)` in its harness.cpp)
// drive the learner's code with and judge it by. The same API as the Go harness, names and all:
// assertions with Go's format verbs (%v %s %d %q %t %g %f %x), the clock, the harness's own Redis
// client (its commands are not the learner's round trips), HTTP into a server in process, and the
// learner's main as a program. A failed assertion throws harness::Failure, which is not a
// std::exception: the learner's `catch (const std::exception&)` lets it through.
// Templates live here; the rest is in cppruntime/src/harness.cpp (libleetbuild.a).
#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <map>
#include <memory>
#include <optional>
#include <ostream>
#include <sstream>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <utility>
#include <vector>

#include <httplib.h>
#include <lb/runtime.h>
#include <leetbuild/db.h>
#include <leetbuild/grpc.h>
#include <leetbuild/kafka.h>

namespace harness {

struct Failure {
  std::string message;
};

// ---- formatting, the Go way ---------------------------------------------------------------------

// Go's strconv.Quote, for %q: escapes, double quotes.
std::string Quote(std::string_view s);

// A float as Go's %v prints it: the shortest digits that round-trip, in %e form when the exponent
// is below -4 or at least the number of digits shown (6 at most): 0.1, 12.5, 100000, 1e+06, 1.5e-05.
std::string FormatFloat(double v);

namespace detail {

template <class T, class = void>
struct streamable : std::false_type {};
template <class T>
struct streamable<T, std::void_t<decltype(std::declval<std::ostream&>() << std::declval<const T&>())>>
    : std::true_type {};

template <class T, class = void>
struct range : std::false_type {};
template <class T>
struct range<T, std::void_t<decltype(std::begin(std::declval<const T&>())), decltype(std::end(std::declval<const T&>()))>>
    : std::true_type {};

template <class T, class = void>
struct map_like : std::false_type {};
template <class T>
struct map_like<T, std::void_t<typename T::key_type, typename T::mapped_type>> : std::true_type {};

template <class T>
struct optional_like : std::false_type {};
template <class T>
struct optional_like<std::optional<T>> : std::true_type {};

template <class T>
struct tuple_like : std::false_type {};
template <class A, class B>
struct tuple_like<std::pair<A, B>> : std::true_type {};
template <class... T>
struct tuple_like<std::tuple<T...>> : std::true_type {};

// nlohmann::json, recognized without its header: compared and shown as a JSON document. It cannot
// go through the range rules, for it is a range of its items and a primitive document a range of itself.
template <class T, class = void>
struct json_document : std::false_type {};
template <class T>
struct json_document<T, std::void_t<typename T::object_t, typename T::array_t, typename T::number_float_t>>
    : std::true_type {};

template <class T>
constexpr bool stringish = std::is_convertible_v<const T&, std::string_view>;

template <class T>
constexpr bool always_false = false;

std::string pointer(const void* p);
std::string sorted_map(std::vector<std::pair<std::string, std::string>> items);

}  // namespace detail

template <class T>
void Show(std::string& out, const T& v, bool quote);

// What Go's %v prints for v (with quote: what %q prints, strings quoted at any depth).
template <class T>
std::string Value(const T& v, bool quote = false) {
  std::string out;
  Show(out, v, quote);
  return out;
}

template <class T>
void Show(std::string& out, const T& v, bool quote) {
  using D = std::decay_t<T>;
  if constexpr (std::is_same_v<D, std::nullptr_t>) {
    out += "<nil>";
  } else if constexpr (std::is_same_v<D, Any>) {
    out += v.Format(quote);
  } else if constexpr (detail::json_document<D>::value) {
    out += v.dump();
  } else if constexpr (std::is_same_v<D, bool>) {
    out += v ? "true" : "false";
  } else if constexpr (std::is_same_v<D, char>) {
    const std::string s(1, v);
    out += quote ? Quote(s) : s;
  } else if constexpr (std::is_enum_v<D>) {
    // A model's enum with names (grpc::StatusCode: DEADLINE_EXCEEDED) shows its name, found by ADL.
    if constexpr (requires { EnumName(v); }) out += EnumName(v);
    else out += std::to_string(static_cast<long long>(v));
  } else if constexpr (std::is_integral_v<D>) {
    if constexpr (std::is_signed_v<D>) {
      out += std::to_string(static_cast<long long>(v));
    } else {
      out += std::to_string(static_cast<unsigned long long>(v));
    }
  } else if constexpr (std::is_floating_point_v<D>) {
    out += FormatFloat(static_cast<double>(v));
  } else if constexpr (detail::stringish<D>) {
    const std::string_view s(v);
    out += quote ? Quote(s) : std::string(s);
  } else if constexpr (detail::optional_like<D>::value) {
    if (v.has_value()) {
      Show(out, *v, quote);
    } else {
      out += "<nil>";
    }
  } else if constexpr (std::is_same_v<D, lb::Json>) {
    out += v.dump();
  } else if constexpr (detail::map_like<D>::value) {
    std::vector<std::pair<std::string, std::string>> items;
    for (const auto& [k, val] : v) items.emplace_back(Value(k, quote), Value(val, quote));
    out += detail::sorted_map(std::move(items));
  } else if constexpr (detail::tuple_like<D>::value) {
    out += '{';
    bool first = true;
    std::apply([&](const auto&... item) { ((out += first ? "" : " ", first = false, Show(out, item, quote)), ...); }, v);
    out += '}';
  } else if constexpr (detail::range<D>::value) {
    out += '[';
    bool first = true;
    for (const auto& item : v) {
      if (!first) out += ' ';
      first = false;
      Show(out, item, quote);
    }
    out += ']';
  } else if constexpr (detail::streamable<D>::value) {
    std::ostringstream s;
    s << v;
    out += quote ? Quote(s.str()) : s.str();
  } else if constexpr (std::is_pointer_v<D>) {
    out += detail::pointer(static_cast<const void*>(v));
  } else {
    out += "{?}";
  }
}

namespace detail {

struct Spec {
  bool minus = false, plus = false, zero = false, space = false, sharp = false;
  int width = -1;
  int precision = -1;
  char verb = 'v';
};

// The formatted text of one argument (the verb's conversion), before width and sign.
std::string convert_integer(unsigned long long magnitude, bool negative, const Spec& spec);
std::string convert_float(double v, const Spec& spec);
std::string convert_string(std::string_view s, const Spec& spec);
std::string pad(std::string text, const Spec& spec, bool numeric);

template <class T>
std::string convert(const Spec& spec, const T& v) {
  using D = std::decay_t<T>;
  if constexpr (std::is_same_v<D, bool> || std::is_same_v<D, char>) {
    return spec.verb == 'q' ? Value(v, true) : Value(v);
  } else if constexpr (std::is_integral_v<D>) {
    const bool negative = std::is_signed_v<D> && v < 0;
    const unsigned long long magnitude =
        negative ? 0ULL - static_cast<unsigned long long>(v) : static_cast<unsigned long long>(v);
    return convert_integer(magnitude, negative, spec);
  } else if constexpr (std::is_floating_point_v<D>) {
    return convert_float(static_cast<double>(v), spec);
  } else if constexpr (stringish<D> && !json_document<D>::value) {
    return convert_string(std::string_view(v), spec);
  } else {
    return spec.verb == 'q' ? Value(v, true) : Value(v);
  }
}

struct Arg {
  const void* value;
  std::string (*text)(const Spec&, const void*);
  bool numeric;
};

template <class T>
Arg make_arg(const T& v) {
  return {&v, [](const Spec& spec, const void* p) { return convert(spec, *static_cast<const T*>(p)); },
          std::is_arithmetic_v<std::decay_t<T>> && !std::is_same_v<std::decay_t<T>, bool>};
}

std::string sprintf(std::string_view format, const Arg* args, size_t count);

}  // namespace detail

// Go's fmt.Sprintf: %v (any value), %s, %d, %q (quoted), %t, %g/%f/%e (with precision), %x, %%.
template <class... A>
std::string Sprintf(std::string_view format, const A&... args) {
  if constexpr (sizeof...(A) == 0) {
    return detail::sprintf(format, nullptr, 0);
  } else {
    const detail::Arg list[] = {detail::make_arg(args)...};
    return detail::sprintf(format, list, sizeof...(A));
  }
}

// How Equal shows a value: strings quoted (at any depth), everything else as %v.
template <class T>
std::string ShowValue(const T& v) {
  return Value(v, true);
}

template <class T>
Any Any::Of(const T& v) {
  using D = std::decay_t<T>;
  if constexpr (std::is_same_v<D, Any>) {
    return v;
  } else if constexpr (std::is_same_v<D, lb::Json>) {
    return FromJson(v);
  } else if constexpr (detail::json_document<D>::value) {
    return FromJson(lb::Json::parse(v.dump()));
  } else if constexpr (std::is_same_v<D, std::nullptr_t> || std::is_same_v<D, std::nullopt_t>) {
    return Any();
  } else if constexpr (std::is_same_v<D, bool>) {
    return Any(v);
  } else if constexpr (std::is_same_v<D, char>) {
    return Any(std::string(1, v));
  } else if constexpr (std::is_integral_v<D> || std::is_enum_v<D>) {
    if constexpr (std::is_unsigned_v<D> && sizeof(D) >= sizeof(int64_t)) {
      if (v > static_cast<D>(INT64_MAX)) return Any(static_cast<double>(v));
    }
    return Any(static_cast<int64_t>(v));
  } else if constexpr (std::is_floating_point_v<D>) {
    return Any(static_cast<double>(v));
  } else if constexpr (detail::stringish<D>) {
    return Any(std::string(std::string_view(v)));
  } else if constexpr (detail::optional_like<D>::value) {
    return v.has_value() ? Of(*v) : Any();
  } else if constexpr (detail::map_like<D>::value) {
    std::map<std::string, Any> fields;
    for (const auto& [k, val] : v) fields.emplace(Value(k), Of(val));
    return Any(std::move(fields));
  } else if constexpr (detail::range<D>::value) {
    std::vector<Any> items;
    for (const auto& item : v) items.push_back(Of(item));
    return Any(std::move(items));
  } else {
    return Unsupported();
  }
}

// ---- equality, the Go harness's ---------------------------------------------------------------

template <class A, class B>
bool Same(const A& a, const B& b);

namespace detail {

template <class A, class B>
bool same_tuple(const A& a, const B& b) {
  if constexpr (std::tuple_size_v<A> != std::tuple_size_v<B>) {
    return false;
  } else {
    return std::apply(
        [&](const auto&... x) { return std::apply([&](const auto&... y) { return (Same(x, y) && ...); }, b); }, a);
  }
}

}  // namespace detail

// Values equal the way the Go harness's Equal compares: numbers by value across integer and
// floating types, strings across string types, containers element by element (a vector equals an
// array of the same items), maps key by key, an optional by its value.
template <class A, class B>
bool Same(const A& a, const B& b) {
  using DA = std::decay_t<A>;
  using DB = std::decay_t<B>;
  if constexpr (std::is_same_v<DA, Any> || std::is_same_v<DB, Any> || std::is_same_v<DA, lb::Json> ||
                std::is_same_v<DB, lb::Json>) {
    return Any::Of(a) == Any::Of(b);
  } else if constexpr (detail::json_document<DA>::value || detail::json_document<DB>::value) {
    // As JSON documents (numbers by value across integer and floating), the other side converted.
    if constexpr (detail::json_document<DA>::value && detail::json_document<DB>::value) return a == b;
    else if constexpr (detail::json_document<DA>::value) return a == DA(b);
    else return DB(a) == b;
  } else if constexpr (std::is_same_v<DA, bool> || std::is_same_v<DB, bool>) {
    if constexpr (std::is_same_v<DA, bool> && std::is_same_v<DB, bool>) return a == b;
    else return false;
  } else if constexpr (std::is_arithmetic_v<DA> && std::is_arithmetic_v<DB>) {
    if constexpr (std::is_integral_v<DA> && std::is_integral_v<DB>) return std::cmp_equal(a, b);
    else return static_cast<long double>(a) == static_cast<long double>(b);
  } else if constexpr (std::is_enum_v<DA> && std::is_enum_v<DB>) {
    return static_cast<long long>(a) == static_cast<long long>(b);
  } else if constexpr (detail::stringish<DA> && detail::stringish<DB>) {
    return std::string_view(a) == std::string_view(b);
  } else if constexpr (detail::optional_like<DA>::value && detail::optional_like<DB>::value) {
    return a.has_value() == b.has_value() && (!a.has_value() || Same(*a, *b));
  } else if constexpr (std::is_same_v<DB, std::nullptr_t> && detail::optional_like<DA>::value) {
    return !a.has_value();
  } else if constexpr (detail::optional_like<DA>::value) {
    return a.has_value() && Same(*a, b);
  } else if constexpr (detail::optional_like<DB>::value) {
    return b.has_value() && Same(a, *b);
  } else if constexpr (std::is_same_v<DA, std::nullptr_t> || std::is_same_v<DB, std::nullptr_t>) {
    if constexpr (std::is_pointer_v<DA> || std::is_pointer_v<DB>) return a == b;
    else return std::is_same_v<DA, DB>;
  } else if constexpr (detail::map_like<DA>::value && detail::map_like<DB>::value) {
    if (a.size() != b.size()) return false;
    for (const auto& [k, v] : a) {
      bool found = false;
      for (const auto& [k2, v2] : b) {
        if (Same(k, k2)) {
          if (!Same(v, v2)) return false;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  } else if constexpr (detail::tuple_like<DA>::value && detail::tuple_like<DB>::value) {
    return detail::same_tuple(a, b);
  } else if constexpr (detail::range<DA>::value && detail::range<DB>::value) {
    auto ia = std::begin(a);
    auto ib = std::begin(b);
    for (; ia != std::end(a) && ib != std::end(b); ++ia, ++ib) {
      if (!Same(*ia, *ib)) return false;
    }
    return ia == std::end(a) && ib == std::end(b);
  } else if constexpr (requires { a == b; }) {
    return a == b;
  } else {
    static_assert(detail::always_false<A>, "harness::Same cannot compare these two types");
    return false;
  }
}

// ---- the world ---------------------------------------------------------------------------------

class Ctx;

// The check's control over virtual time.
class Clock {
 public:
  // Move virtual time forward by seconds: keys expire, windows roll over, deadlines pass, timers
  // fire. Threads the timers woke run once the harness next waits (Settle, a blocking call).
  void Advance(double seconds);
  template <class Rep, class Period>
  void AdvanceBy(std::chrono::duration<Rep, Period> d) {
    Advance(std::chrono::duration<double>(d).count());
  }
  // Virtual time in milliseconds since the epoch (what the learner's system_clock::now() reads).
  int64_t Now() const;
  // Jumps virtual time made for sleeps in this check so far.
  int Sleeps() const;
  // How many jumps virtual time may make for sleeps before the program's loops are suspended
  // (default 500). Raised past Sleeps() once they were, they go on: SetSleepLimit(Sleeps() + 5).
  void SetSleepLimit(int n);
};

// A Redis reply: nil, a string, an integer, or an array of replies.
class Reply {
 public:
  Reply() = default;
  explicit Reply(lb::Json v) : v_(std::move(v)) {}
  bool IsNil() const { return v_.is_null(); }
  bool IsArray() const { return v_.is_array(); }
  bool IsInt() const { return v_.is_number(); }
  // The reply as a string (an integer in decimal).
  std::string String() const;
  long long Int() const;
  double Float() const;
  std::vector<Reply> Array() const;
  std::vector<std::string> Strings() const;
  const lb::Json& Raw() const { return v_; }
  friend std::ostream& operator<<(std::ostream& out, const Reply& r);

 private:
  lb::Json v_;
};

namespace detail {

template <class T>
std::string arg_text(const T& v) {
  if constexpr (stringish<T>) return std::string(std::string_view(v));
  else return Value(v);
}

}  // namespace detail

// The harness's own Redis client, on the server the learner's code uses: its commands are not
// counted as the learner's round trips and fire no probes.
class Redis {
 public:
  explicit Redis(Ctx& ctx) : ctx_(ctx) {}

  // A command; the error message, if Redis answered with one.
  template <class... A>
  std::pair<Reply, std::optional<std::string>> DoErr(const A&... args) {
    return Execute({detail::arg_text(args)...});
  }
  // A command; an error reply fails the check.
  template <class... A>
  Reply Do(const A&... args) {
    return Must({detail::arg_text(args)...});
  }
  std::pair<Reply, std::optional<std::string>> Execute(const std::vector<std::string>& args);
  Reply Must(const std::vector<std::string>& args);

  std::optional<std::string> Get(const std::string& key);
  template <class V, class... O>
  bool Set(const std::string& key, const V& value, const O&... options) {
    return !Do("SET", key, value, options...).IsNil();
  }
  template <class... K>
  long long Del(const K&... keys) {
    return Do("DEL", keys...).Int();
  }
  template <class... K>
  long long Exists(const K&... keys) {
    return Do("EXISTS", keys...).Int();
  }
  long long TTL(const std::string& key);
  long long PTTL(const std::string& key);
  std::string Type(const std::string& key);
  std::vector<std::string> Keys(const std::string& pattern);
  std::optional<std::string> HGet(const std::string& key, const std::string& field);
  std::map<std::string, std::string> HGetAll(const std::string& key);
  long long HLen(const std::string& key);
  std::vector<std::string> LRange(const std::string& key, long long start, long long stop);
  long long LLen(const std::string& key);
  std::vector<std::string> SMembers(const std::string& key);
  bool SIsMember(const std::string& key, const std::string& member);
  long long SCard(const std::string& key);

  struct Z {
    std::string Member;
    double Score;
    bool operator==(const Z& o) const { return Member == o.Member && Score == o.Score; }
    friend std::ostream& operator<<(std::ostream& out, const Z& z);
  };
  std::vector<Z> ZRangeWithScores(const std::string& key, long long start, long long stop);
  std::vector<Z> ZRevRangeWithScores(const std::string& key, long long start, long long stop);
  std::optional<double> ZScore(const std::string& key, const std::string& member);
  long long ZCard(const std::string& key);
  long long Publish(const std::string& channel, const std::string& message);

  // Run fn right after the first command of the learner's that touches key, before that command's
  // reply reaches the learner: another client racing between two of the learner's commands.
  void After(const std::string& key, std::function<void()> fn);

  // Receive what is published on channel (on a thread of its own, as it arrives).
  void Subscribe(const std::string& channel,
                 std::function<void(const std::string& channel, const std::string& message)> fn);

  // The learner's round trips so far: each the commands it carried, as name and arguments.
  std::vector<std::vector<std::string>> RoundTrips();

 private:
  Ctx& ctx_;
};

// What a server answered.
struct Response {
  int Status = 0;
  httplib::Headers Header;
  std::string Body;

  std::string Text() const { return Body; }
  // The body as JSON (the runtime's JSON value; parse with nlohmann::json::parse(r.Text()) for more).
  lb::Json JSON() const;
  std::string HeaderValue(const std::string& key) const;
};

// A client of a server in process: each request goes through the server's routing, on this thread.
class HTTP {
 public:
  HTTP(Ctx& ctx, httplib::Server& server) : ctx_(&ctx), server_(&server) {}

  // Requests from another client address (the server reads it as req.remote_addr).
  HTTP From(const std::string& remote) const;

  // A request: method, path (with its query), a body, then header names and values in pairs.
  template <class... H>
  Response Do(const std::string& method, const std::string& path, const std::string& body, const H&... header) {
    static_assert(sizeof...(H) % 2 == 0, "headers come in name, value pairs");
    return Send(method, path, body, {std::string(header)...});
  }
  Response Send(const std::string& method, const std::string& path, const std::string& body,
                const std::vector<std::string>& headers);
  // A request that stays in flight until released (Go's Hold): the server counts it from now (a
  // graceful shutdown waits for it); calling the returned function routes it, ends it and returns
  // the response.
  template <class... H>
  std::function<Response()> Hold(const std::string& method, const std::string& path, const std::string& body,
                                 const H&... header) {
    static_assert(sizeof...(H) % 2 == 0, "headers come in name, value pairs");
    return HoldRequest(method, path, body, {std::string(header)...});
  }
  std::function<Response()> HoldRequest(const std::string& method, const std::string& path, const std::string& body,
                                        const std::vector<std::string>& headers);
  template <class... H>
  Response Get(const std::string& path, const H&... header) {
    return Do("GET", path, "", header...);
  }
  template <class... H>
  Response Head(const std::string& path, const H&... header) {
    return Do("HEAD", path, "", header...);
  }
  template <class... H>
  Response Delete(const std::string& path, const H&... header) {
    return Do("DELETE", path, "", header...);
  }
  template <class... H>
  Response Options(const std::string& path, const H&... header) {
    return Do("OPTIONS", path, "", header...);
  }
  template <class... H>
  Response Post(const std::string& path, const std::string& body, const H&... header) {
    return Do("POST", path, body, header...);
  }
  template <class... H>
  Response Put(const std::string& path, const std::string& body, const H&... header) {
    return Do("PUT", path, body, header...);
  }
  template <class... H>
  Response Patch(const std::string& path, const std::string& body, const H&... header) {
    return Do("PATCH", path, body, header...);
  }

 private:
  Ctx* ctx_;
  httplib::Server* server_;
  std::string remote_ = "127.0.0.1";
};

// The learner's main, running on a thread of its own.
class Program {
 public:
  struct State {
    int thread = 0;
    bool done = false;
    int status = 0;
  };
  Program(Ctx& ctx, std::shared_ptr<State> state) : ctx_(ctx), state_(std::move(state)) {}

  // Whether main has not returned (nor exited).
  bool Running() const;
  // The exit status, once main returned or the program called exit().
  std::optional<int> Exited() const;
  // The servers main listens with.
  std::vector<httplib::Server*> Servers() const;
  // Whether any of them still accepts requests.
  bool Listening() const;
  // Send sig (SIGTERM, SIGINT) to the program, as `kill` would: a thread in sigwait() receives it,
  // else its handler runs, else the default action (SIGTERM ends the program). How many received it.
  int Signal(int sig);
  // A client of the program's HTTP server; the check fails unless main listens on exactly one.
  harness::HTTP HTTP();
  // A client of the server listening on port.
  harness::HTTP HTTPAt(int port);

 private:
  std::string describe() const;
  Ctx& ctx_;
  std::shared_ptr<State> state_;
};

class Ctx {
 public:
  harness::Clock Clock;
  harness::Redis Redis{*this};
  harness::Kafka Kafka{*this};
  harness::GRPC GRPC{*this};
  harness::DB DB{*this};

  // Fail the check now with the formatted message.
  template <class... A>
  [[noreturn]] void Fatalf(std::string_view format, const A&... args) {
    Fail(Sprintf(format, args...));
  }
  [[noreturn]] void Fail(std::string message);
  // Fail the check with the message unless cond holds.
  template <class... A>
  void Assert(bool cond, std::string_view format, const A&... args) {
    if (!cond) Fatalf(format, args...);
  }
  // Fail the check unless got equals want (harness::Same); the message gets ": got X, want Y".
  template <class G, class W, class... A>
  void Equal(const G& got, const W& want, std::string_view format, const A&... args) {
    if (Same(got, want)) return;
    Differ(Sprintf(format, args...), ShowValue(got), ShowValue(want));
  }
  template <class G, class E, class... A>
  void Equal(const G& got, std::initializer_list<E> want, std::string_view format, const A&... args) {
    Equal(got, std::vector<E>(want), format, args...);
  }
  [[noreturn]] void Differ(std::string message, const std::string& got, const std::string& want);

  // Let every thread the learner started run until the world settles: the clock jumps to pending
  // sleeps and timers, firing them, until none is left.
  void Settle();
  // Let every thread run until each is blocked, the clock held where it is.
  void Tick();
  // Run fn (the learner's consume loop) until it returns or the world settles with it still
  // waiting; whether it returned. What it threw is rethrown here.
  bool Drain(std::function<void()> fn);

  // An HTTP client of server, in process.
  harness::HTTP HTTP(httplib::Server& server) { return harness::HTTP(*this, server); }

  // Run the learner's main on a thread of its own; returns once the world settles (it serves,
  // consumes, or waits). The step's file needs a main.
  Program Main();
  // Run main (any `int()`) the way Main does.
  Program Start(int (*main)());
};

// The type of the exception in flight, demangled; report it as the check's failure (a
// harness::Failure as its message, anything else after `prefix`).
std::string CurrentExceptionType();
void ReportCurrentException(const std::string& prefix);

}  // namespace harness
