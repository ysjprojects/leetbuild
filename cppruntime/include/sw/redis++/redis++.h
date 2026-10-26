// redis-plus-plus (https://github.com/sewenew/redis-plus-plus), as the LeetBuild C++ runtime models
// it: the same sw::redis::Redis API over the runtime's Redis server — the one every language's
// checks share, with Lua scripting — instead of a socket. Each command is one round trip the
// harness counts; a pipeline or a transaction is one. Replies parse into the types redis++ returns
// (OptionalString, long long, double, bool, containers through output iterators, ReplyUPtr — a
// hiredis redisReply — from the generic command()).
//
// Beyond the real API, a few forms course code reaches for are accepted too, each doing what its
// call site plainly means: commands that take an output iterator also return their result
// (`redis.hgetall(key)` → unordered_map, `redis.lrange(key, 0, -1)` → vector, …); eval/evalsha
// take keys and arguments as braced lists of strings or numbers, as containers, or as iterator
// pairs, with Result optional (a reply that converts, compares and dereferences) and
// `eval<std::string>` testable like an optional; `eval<A, B, C>` returns a tuple;
// `scan(cursor, pattern, count)` returns {next cursor, keys}; `set(key, value, seconds)` with an
// integer TTL; `incr(key, n)`; `hset(key, field, value, field, value, …)`.
#pragma once

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <hiredis/hiredis.h>
#include <lb/runtime.h>

namespace sw::redis {

using StringView = std::string_view;
template <class T>
using Optional = std::optional<T>;
using OptionalString = std::optional<std::string>;
using OptionalLongLong = std::optional<long long>;
using OptionalDouble = std::optional<double>;
using OptionalStringPair = std::optional<std::pair<std::string, std::string>>;

class Error : public std::exception {
 public:
  explicit Error(std::string msg) : msg_(std::move(msg)) {}
  const char* what() const noexcept override { return msg_.c_str(); }

 private:
  std::string msg_;
};
class IoError : public Error {
 public:
  using Error::Error;
};
class TimeoutError : public IoError {
 public:
  using IoError::IoError;
};
class ClosedError : public Error {
 public:
  using Error::Error;
};
class ProtoError : public Error {
 public:
  using Error::Error;
};
class OomError : public Error {
 public:
  using Error::Error;
};
class ReplyError : public Error {
 public:
  using Error::Error;
};
class WatchError : public Error {
 public:
  explicit WatchError(std::string msg = "Watched key has been modified") : Error(std::move(msg)) {}
};

enum class UpdateType { EXIST, NOT_EXIST, ALWAYS, GREATER, LESS };
enum class BoundType { CLOSED, OPEN, LEFT_OPEN, RIGHT_OPEN };
enum class GeoUnit { M, KM, MI, FT };
enum class InsertPosition { BEFORE, AFTER };
enum class Aggregation { SUM, MIN, MAX };
enum class ConnectionType { TCP = 0, UNIX };

struct ConnectionOptions {
  ConnectionType type = ConnectionType::TCP;
  std::string host = "127.0.0.1";
  int port = 6379;
  std::string path;
  std::string user = "default";
  std::string password;
  int db = 0;
  bool keep_alive = false;
  std::chrono::milliseconds connect_timeout{0};
  // A subscriber's consume() throws TimeoutError once this much (virtual) time passes without a message.
  std::chrono::milliseconds socket_timeout{0};
  bool readonly = false;
  int resp = 2;
};

struct ConnectionPoolOptions {
  std::size_t size = 1;
  std::chrono::milliseconds wait_timeout{0};
  std::chrono::milliseconds connection_lifetime{0};
  std::chrono::milliseconds connection_idle_time{0};
};

struct LimitOptions {
  long long offset = 0;
  long long count = -1;
};

// The reply of the generic command(): hiredis's reply, freed when the pointer goes.
namespace detail {
struct ReplyDeleter {
  void operator()(redisReply* reply) const;
};
}  // namespace detail
using ReplyUPtr = std::unique_ptr<redisReply, detail::ReplyDeleter>;

namespace detail {

std::string number(double v);

// A score bound as Redis reads it: `5`, `(5`, `-inf`, `+inf`; a lexicographical one: `[a`, `(a`.
std::string bound(double v, bool open);
std::string bound(const std::string& v, bool open);
inline std::string bound(std::string_view v, bool open) { return bound(std::string(v), open); }

template <class T>
std::string lowest() {
  if constexpr (std::is_arithmetic_v<T>) return "-inf";
  else return "-";
}
template <class T>
std::string highest() {
  if constexpr (std::is_arithmetic_v<T>) return "+inf";
  else return "+";
}

// hiredis replies (cppruntime/src/hiredis.cpp): from a reply as the bridge carries it, and back.
bool status_command(const std::string& name);
redisReply* make_reply(const lb::Json& r, bool status);
lb::Json reply_json(const redisReply& r);

}  // namespace detail

template <class T>
class BoundedInterval {
 public:
  BoundedInterval(const T& min, const T& max, BoundType type) : min_(min), max_(max), type_(type) {}
  std::string lower() const { return detail::bound(min_, type_ == BoundType::OPEN || type_ == BoundType::LEFT_OPEN); }
  std::string upper() const { return detail::bound(max_, type_ == BoundType::OPEN || type_ == BoundType::RIGHT_OPEN); }

 private:
  T min_, max_;
  BoundType type_;
};

template <class T>
class LeftBoundedInterval {
 public:
  LeftBoundedInterval(const T& min, BoundType type) : min_(min), type_(type) {}
  std::string lower() const { return detail::bound(min_, type_ == BoundType::OPEN || type_ == BoundType::LEFT_OPEN); }
  std::string upper() const { return detail::highest<T>(); }

 private:
  T min_;
  BoundType type_;
};

template <class T>
class RightBoundedInterval {
 public:
  RightBoundedInterval(const T& max, BoundType type) : max_(max), type_(type) {}
  std::string lower() const { return detail::lowest<T>(); }
  std::string upper() const { return detail::bound(max_, type_ == BoundType::OPEN || type_ == BoundType::RIGHT_OPEN); }

 private:
  T max_;
  BoundType type_;
};

template <class T>
class UnboundedInterval {
 public:
  std::string lower() const { return detail::lowest<T>(); }
  std::string upper() const { return detail::highest<T>(); }
};

namespace reply {

template <class T>
struct is_optional : std::false_type {};
template <class T>
struct is_optional<std::optional<T>> : std::true_type {};
template <class T>
struct is_pair : std::false_type {};
template <class A, class B>
struct is_pair<std::pair<A, B>> : std::true_type {};
template <class T>
struct is_tuple : std::false_type {};
template <class... T>
struct is_tuple<std::tuple<T...>> : std::true_type {};
template <class T, class = void>
struct is_map : std::false_type {};
template <class T>
struct is_map<T, std::void_t<typename T::key_type, typename T::mapped_type>> : std::true_type {};
template <class T, class = void>
struct is_container : std::false_type {};
template <class T>
struct is_container<T, std::void_t<typename T::value_type, decltype(std::declval<T&>().insert(std::declval<T&>().end(), std::declval<typename T::value_type>()))>>
    : std::true_type {};

template <class T>
T parse(const lb::Json& r);

template <class Tuple, size_t... I>
Tuple parse_tuple(const lb::Json& r, std::index_sequence<I...>) {
  static const lb::Json nil;
  return Tuple(parse<std::tuple_element_t<I, Tuple>>(I < r.size() ? r[I] : nil)...);
}

// A reply as T, the way redis++ converts: integers and strings either way, nil to an empty optional.
template <class T>
T parse(const lb::Json& r) {
  if constexpr (std::is_same_v<T, void>) {
    return;
  } else if constexpr (std::is_same_v<T, lb::Json>) {
    return r;
  } else if constexpr (std::is_same_v<T, ReplyUPtr>) {
    return ReplyUPtr(detail::make_reply(r, false));
  } else if constexpr (is_optional<T>::value) {
    if (r.is_null()) return std::nullopt;
    return parse<typename T::value_type>(r);
  } else if constexpr (std::is_same_v<T, std::string>) {
    if (r.is_null()) throw ProtoError("expect STRING reply");
    if (r.is_number()) return std::to_string(r.as_int());
    return r.as_string();
  } else if constexpr (std::is_same_v<T, bool>) {
    if (r.is_string()) return r.as_string() == "OK" || r.as_string() == "1";
    return r.as_int() != 0;
  } else if constexpr (std::is_integral_v<T>) {
    if (r.is_string()) return static_cast<T>(std::stoll(r.as_string()));
    return static_cast<T>(r.as_int());
  } else if constexpr (std::is_floating_point_v<T>) {
    if (r.is_string()) {
      const std::string& s = r.as_string();
      if (s == "inf" || s == "+inf") return std::numeric_limits<T>::infinity();
      if (s == "-inf") return -std::numeric_limits<T>::infinity();
      return static_cast<T>(std::stod(s));
    }
    return static_cast<T>(r.as_number());
  } else if constexpr (is_pair<T>::value) {
    using A = std::remove_const_t<typename T::first_type>;
    using B = typename T::second_type;
    return T(parse<A>(r[0]), parse<B>(r[1]));
  } else if constexpr (is_tuple<T>::value) {
    return parse_tuple<T>(r, std::make_index_sequence<std::tuple_size_v<T>>{});
  } else if constexpr (is_map<T>::value) {
    T out;
    const auto& items = r.items();
    if (!items.empty() && items[0].is_array()) {
      for (const auto& item : items) out.emplace(parse<typename T::key_type>(item[0]), parse<typename T::mapped_type>(item[1]));
      return out;
    }
    for (size_t i = 0; i + 1 < items.size(); i += 2) {
      out.emplace(parse<typename T::key_type>(items[i]), parse<typename T::mapped_type>(items[i + 1]));
    }
    return out;
  } else if constexpr (is_container<T>::value) {
    T out;
    using V = typename T::value_type;
    const auto& items = r.items();
    if constexpr (is_pair<V>::value) {
      // Pairs come flat in RESP2 (field value field value …), or as nested arrays.
      if (!items.empty() && !items[0].is_array()) {
        for (size_t i = 0; i + 1 < items.size(); i += 2) {
          out.insert(out.end(), V(parse<std::remove_const_t<typename V::first_type>>(items[i]),
                                  parse<typename V::second_type>(items[i + 1])));
        }
        return out;
      }
    }
    for (const auto& item : items) out.insert(out.end(), parse<V>(item));
    return out;
  } else {
    static_assert(sizeof(T) == 0, "this reply type is not modelled");
  }
}

// redis++'s reply::parse of a hiredis reply (what command() returns).
template <class T>
T parse(redisReply& r) {
  return parse<T>(detail::reply_json(r));
}

inline bool is_nil(const redisReply& r) { return r.type == REDIS_REPLY_NIL; }
inline bool is_string(const redisReply& r) { return r.type == REDIS_REPLY_STRING; }
inline bool is_status(const redisReply& r) { return r.type == REDIS_REPLY_STATUS; }
inline bool is_error(const redisReply& r) { return r.type == REDIS_REPLY_ERROR; }
inline bool is_integer(const redisReply& r) { return r.type == REDIS_REPLY_INTEGER; }
inline bool is_array(const redisReply& r) { return r.type == REDIS_REPLY_ARRAY; }

// The element type an output iterator takes (back_inserter, inserter, front_inserter of a container).
template <class Output, class = void>
struct element {
  using type = std::string;
};
template <class Output>
struct element<Output, std::void_t<typename Output::container_type>> {
  using type = typename Output::container_type::value_type;
};
template <class T>
struct element<T*, void> {
  using type = T;
};

template <class T>
struct unconst_pair {
  using type = T;
};
template <class A, class B>
struct unconst_pair<std::pair<A, B>> {
  using type = std::pair<std::remove_const_t<A>, B>;
};

template <class Output>
using element_t = typename unconst_pair<typename element<Output>::type>::type;

// Write an array reply to output, one element (or, for pairs from a flat reply, two) at a time.
template <class Output>
void to_output(const lb::Json& r, Output output) {
  using V = element_t<Output>;
  const auto& items = r.items();
  if constexpr (is_pair<V>::value) {
    if (!items.empty() && !items[0].is_array()) {
      for (size_t i = 0; i + 1 < items.size(); i += 2) {
        *output = V(parse<typename V::first_type>(items[i]), parse<typename V::second_type>(items[i + 1]));
        ++output;
      }
      return;
    }
  }
  for (const auto& item : items) {
    *output = parse<V>(item);
    ++output;
  }
}

}  // namespace reply

namespace detail {

template <class T>
concept stringish = std::is_convertible_v<const T&, std::string_view>;

template <class T>
concept range = !stringish<T> && requires(const T& t) {
  std::begin(t);
  std::end(t);
};

// An output iterator (or anything that is not a value, a string or a range).
template <class T>
concept output = !stringish<T> && !range<T> && !std::is_arithmetic_v<T> && !std::is_enum_v<T>;

// An input iterator over arguments.
template <class T>
concept iterator = !stringish<T> && !range<T> && !std::is_arithmetic_v<T> && requires(T it) {
  *it;
  ++it;
};

inline void add(std::vector<std::string>& args, const std::string& s) { args.push_back(s); }
inline void add(std::vector<std::string>& args, std::string_view s) { args.emplace_back(s); }
inline void add(std::vector<std::string>& args, const char* s) { args.emplace_back(s); }
inline void add(std::vector<std::string>& args, char* s) { args.emplace_back(s); }
// Anything else that converts to a string (a regex sub_match, …).
template <class T>
  requires(!std::is_convertible_v<const T&, std::string_view> && std::is_convertible_v<const T&, std::string> &&
           !std::is_arithmetic_v<T>)
void add(std::vector<std::string>& args, const T& v) {
  args.push_back(std::string(v));
}
inline void add(std::vector<std::string>& args, double v) { args.push_back(number(v)); }
inline void add(std::vector<std::string>& args, float v) { args.push_back(number(v)); }
template <class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
void add(std::vector<std::string>& args, T v) {
  args.push_back(std::to_string(v));
}
template <class A, class B>
void add(std::vector<std::string>& args, const std::pair<A, B>& p) {
  add(args, p.first);
  add(args, p.second);
}
template <range T>
void add(std::vector<std::string>& args, const T& items) {
  for (const auto& item : items) add(args, item);
}
template <class T>
void add(std::vector<std::string>& args, std::initializer_list<T> items) {
  for (const auto& item : items) add(args, item);
}

template <class... A>
std::vector<std::string> cmd(const A&... parts) {
  std::vector<std::string> args;
  args.reserve(sizeof...(A));
  (add(args, parts), ...);
  return args;
}

template <class Input>
std::vector<std::string> range_args(Input first, Input last) {
  std::vector<std::string> args;
  for (; first != last; ++first) add(args, *first);
  return args;
}

inline std::vector<std::string> join(std::vector<std::string> a, const std::vector<std::string>& b) {
  a.insert(a.end(), b.begin(), b.end());
  return a;
}

// A script key or argument: a string, or a number in its decimal form.
struct Arg {
  std::string text;
  Arg(const char* s) : text(s) {}
  Arg(const std::string& s) : text(s) {}
  Arg(std::string_view s) : text(s) {}
  template <class T>
    requires(!std::is_convertible_v<const T&, std::string_view> && std::is_convertible_v<const T&, std::string> &&
             !std::is_arithmetic_v<T>)
  Arg(const T& v) : text(std::string(v)) {}
  template <class T>
    requires(std::is_arithmetic_v<T> && !std::is_same_v<T, bool>)
  Arg(T v) {
    std::vector<std::string> one;
    add(one, v);
    text = std::move(one[0]);
  }
};

using Args = std::initializer_list<Arg>;

inline std::vector<std::string> arg_list(Args items) {
  std::vector<std::string> out;
  for (const Arg& a : items) out.push_back(a.text);
  return out;
}
template <range C>
std::vector<std::string> arg_list(const C& items) {
  std::vector<std::string> out;
  for (const auto& item : items) out.push_back(Arg(item).text);
  return out;
}
template <class Input>
std::vector<std::string> arg_list(Input first, Input last) {
  std::vector<std::string> out;
  for (; first != last; ++first) out.push_back(Arg(*first).text);
  return out;
}

std::vector<std::string> script_cmd(const char* name, std::string_view script, const std::vector<std::string>& keys,
                                    const std::vector<std::string>& args);

// Redis strings cross the bridge as latin-1, as the Go runtime's do: each byte is one code point
// U+0000..U+00FF, so any bytes survive. to_bridge encodes one string; from_bridge decodes every
// string of a reply, at any depth (arrays, tagged {r}/{e} objects).
std::string to_bridge(std::string_view bytes);
std::string from_bridge(std::string_view text);
lb::Json from_bridge(const lb::Json& v);

lb::Json to_json(const std::vector<std::string>& args);

// One command on the runtime's server: its reply, or a ReplyError with Redis's message.
lb::Json execute(const std::vector<std::string>& args);

std::string update_flag(UpdateType type);
std::string unit(GeoUnit u);

// What a script returned when the caller named no Result: converts to what it is read as,
// compares with numbers and strings, and like an optional, tests for nil and dereferences.
class ScriptReply {
 public:
  ScriptReply() = default;
  explicit ScriptReply(lb::Json r) : r_(std::move(r)) {}
  explicit operator bool() const { return !r_.is_null(); }
  std::string operator*() const { return r_.is_null() ? std::string() : reply::parse<std::string>(r_); }
  template <class T>
  T as() const {
    return reply::parse<T>(r_);
  }
  operator std::string() const { return **this; }
  operator long long() const { return r_.is_null() ? 0 : reply::parse<long long>(r_); }
  const lb::Json& raw() const { return r_; }
  template <class I>
    requires std::is_integral_v<I>
  friend bool operator==(const ScriptReply& a, I b) {
    if (a.r_.is_number()) return a.r_.as_int() == static_cast<long long>(b);
    return a.r_.is_string() && a.r_.as_string() == std::to_string(b);
  }
  friend bool operator==(const ScriptReply& a, std::string_view b) { return a && *a == b; }
  friend bool operator==(const ScriptReply& a, const char* b) { return a == std::string_view(b); }
  friend bool operator==(const ScriptReply& a, const std::string& b) { return a == std::string_view(b); }

 private:
  lb::Json r_;
};

// eval<std::string>'s result: the string, and (nil or not) testable and dereferenceable like an optional.
class ScriptString : public std::string {
 public:
  ScriptString() = default;
  ScriptString(std::string s, bool present) : std::string(std::move(s)), present_(present) {}
  explicit operator bool() const { return present_; }
  bool has_value() const { return present_; }
  const std::string& operator*() const { return *this; }
  const std::string* operator->() const { return this; }
  const std::string& value() const { return *this; }
  std::string value_or(std::string fallback) const { return present_ ? std::string(*this) : std::move(fallback); }

 private:
  bool present_ = false;
};

template <class Result, class... More>
struct script_result {
  using type = std::conditional_t<(sizeof...(More) > 0), std::tuple<Result, More...>,
                                  std::conditional_t<std::is_same_v<Result, std::string>, ScriptString, Result>>;
};

template <class Result, class... More>
typename script_result<Result, More...>::type script_parse(const lb::Json& r) {
  using T = typename script_result<Result, More...>::type;
  if constexpr (std::is_same_v<T, ScriptString>) {
    if (r.is_null()) return ScriptString();
    return ScriptString(reply::parse<std::string>(r), true);
  } else if constexpr (std::is_same_v<T, ScriptReply>) {
    return ScriptReply(r);
  } else {
    return reply::parse<T>(r);
  }
}

// GEORADIUS's WITH* options, from the output's element type: (member, distance as double, hash as
// an integer, coordinates as a pair of doubles), in any combination after the member.
template <class V>
std::vector<std::string> geo_options() {
  std::vector<std::string> out;
  if constexpr (reply::is_tuple<V>::value) {
    bool dist = false, hash = false, coord = false;
    [&]<size_t... I>(std::index_sequence<I...>) {
      ((I == 0 ? void()
               : std::is_floating_point_v<std::tuple_element_t<I, V>>  ? void(dist = true)
               : std::is_integral_v<std::tuple_element_t<I, V>>        ? void(hash = true)
               : reply::is_pair<std::tuple_element_t<I, V>>::value     ? void(coord = true)
                                                                       : void()),
       ...);
    }(std::make_index_sequence<std::tuple_size_v<V>>{});
    if (dist) out.push_back("WITHDIST");
    if (hash) out.push_back("WITHHASH");
    if (coord) out.push_back("WITHCOORD");
  }
  return out;
}

}  // namespace detail

// The replies of a pipeline or a transaction, in command order.
class QueuedReplies {
 public:
  QueuedReplies(std::vector<lb::Json> replies, std::vector<std::string> errors)
      : replies_(std::move(replies)), errors_(std::move(errors)) {}
  std::size_t size() const { return replies_.size(); }
  template <class T>
  T get(std::size_t idx) {
    check(idx);
    return reply::parse<T>(replies_[idx]);
  }
  template <class Output>
  void get(std::size_t idx, Output output) {
    check(idx);
    reply::to_output(replies_[idx], output);
  }
  // The raw hiredis reply.
  redisReply& get(std::size_t idx);

 private:
  void check(std::size_t idx) const;
  std::vector<lb::Json> replies_;
  std::vector<std::string> errors_;
  std::vector<ReplyUPtr> raw_;
};

namespace detail {

// The queued commands, sent in one round trip (op: redis.pipeline or redis.transaction); the queue empties.
QueuedReplies send_queued(const char* op, std::vector<std::vector<std::string>>& queued);

// WATCHed keys and what they held, checked when the transaction runs.
struct WatchState {
  std::vector<std::pair<std::string, std::string>> keys;
};
void watch(WatchState& state, const std::vector<std::string>& keys);
// Whether every watched key still holds what it held (the watch list empties either way).
bool watch_intact(WatchState& state);

}  // namespace detail

// How a command's result comes back: now (a Redis), or as the queue to chain the next command on
// (a pipeline or a transaction, whose results exec() returns).
struct Immediate {
  template <class T>
  using Result = T;
};
template <class Self>
struct Deferred {
  template <class T>
  using Result = Self&;
};

// The command set, written once: a Redis runs each command now; a pipeline or a transaction queues it.
template <class Impl, class Mode>
class Commands {
 protected:
  template <class T>
  using Ret = typename Mode::template Result<T>;

  template <class T>
  Ret<T> run(std::vector<std::string> args) {
    return static_cast<Impl*>(this)->template dispatch<T>(std::move(args));
  }

 public:
  // ---- connection
  Ret<std::string> ping() { return run<std::string>(detail::cmd("PING")); }
  Ret<std::string> ping(const StringView& msg) { return run<std::string>(detail::cmd("PING", msg)); }
  Ret<std::string> echo(const StringView& msg) { return run<std::string>(detail::cmd("ECHO", msg)); }
  Ret<void> select(long long idx) { return run<void>(detail::cmd("SELECT", idx)); }
  Ret<void> flushall(bool = false) { return run<void>(detail::cmd("FLUSHALL")); }
  Ret<void> flushdb(bool = false) { return run<void>(detail::cmd("FLUSHDB")); }
  Ret<long long> dbsize() { return run<long long>(detail::cmd("DBSIZE")); }

  // ---- keys
  Ret<long long> del(const StringView& key) { return run<long long>(detail::cmd("DEL", key)); }
  template <detail::iterator Input>
  Ret<long long> del(Input first, Input last) {
    return run<long long>(detail::join({"DEL"}, detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> del(std::initializer_list<T> il) {
    return del(il.begin(), il.end());
  }
  Ret<long long> unlink(const StringView& key) { return run<long long>(detail::cmd("UNLINK", key)); }
  template <detail::iterator Input>
  Ret<long long> unlink(Input first, Input last) {
    return run<long long>(detail::join({"UNLINK"}, detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> unlink(std::initializer_list<T> il) {
    return unlink(il.begin(), il.end());
  }
  Ret<long long> exists(const StringView& key) { return run<long long>(detail::cmd("EXISTS", key)); }
  template <detail::iterator Input>
  Ret<long long> exists(Input first, Input last) {
    return run<long long>(detail::join({"EXISTS"}, detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> exists(std::initializer_list<T> il) {
    return exists(il.begin(), il.end());
  }
  Ret<bool> expire(const StringView& key, long long seconds) { return run<bool>(detail::cmd("EXPIRE", key, seconds)); }
  Ret<bool> expire(const StringView& key, const std::chrono::seconds& timeout) { return expire(key, timeout.count()); }
  Ret<bool> pexpire(const StringView& key, long long ms) { return run<bool>(detail::cmd("PEXPIRE", key, ms)); }
  Ret<bool> pexpire(const StringView& key, const std::chrono::milliseconds& timeout) {
    return pexpire(key, timeout.count());
  }
  Ret<bool> expireat(const StringView& key, long long timestamp) {
    return run<bool>(detail::cmd("EXPIREAT", key, timestamp));
  }
  Ret<bool> expireat(const StringView& key,
                     const std::chrono::time_point<std::chrono::system_clock, std::chrono::seconds>& tp) {
    return expireat(key, tp.time_since_epoch().count());
  }
  Ret<bool> pexpireat(const StringView& key, long long timestamp) {
    return run<bool>(detail::cmd("PEXPIREAT", key, timestamp));
  }
  Ret<bool> pexpireat(const StringView& key,
                      const std::chrono::time_point<std::chrono::system_clock, std::chrono::milliseconds>& tp) {
    return pexpireat(key, tp.time_since_epoch().count());
  }
  Ret<bool> persist(const StringView& key) { return run<bool>(detail::cmd("PERSIST", key)); }
  Ret<long long> ttl(const StringView& key) { return run<long long>(detail::cmd("TTL", key)); }
  Ret<long long> pttl(const StringView& key) { return run<long long>(detail::cmd("PTTL", key)); }
  Ret<std::string> type(const StringView& key) { return run<std::string>(detail::cmd("TYPE", key)); }
  Ret<void> rename(const StringView& key, const StringView& newkey) { return run<void>(detail::cmd("RENAME", key, newkey)); }
  Ret<bool> renamenx(const StringView& key, const StringView& newkey) {
    return run<bool>(detail::cmd("RENAMENX", key, newkey));
  }
  Ret<long long> touch(const StringView& key) { return run<long long>(detail::cmd("TOUCH", key)); }

  // ---- strings
  Ret<OptionalString> get(const StringView& key) { return run<OptionalString>(detail::cmd("GET", key)); }
  Ret<bool> set(const StringView& key, const StringView& val,
                const std::chrono::milliseconds& ttl = std::chrono::milliseconds(0),
                UpdateType type = UpdateType::ALWAYS) {
    std::vector<std::string> args = detail::cmd("SET", key, val);
    if (ttl.count() > 0) {
      args.push_back("PX");
      args.push_back(std::to_string(ttl.count()));
    }
    if (type != UpdateType::ALWAYS) args.push_back(detail::update_flag(type));
    return run<bool>(std::move(args));
  }
  Ret<bool> set(const StringView& key, const StringView& val, bool keepttl, UpdateType type = UpdateType::ALWAYS) {
    std::vector<std::string> args = detail::cmd("SET", key, val);
    if (keepttl) args.push_back("KEEPTTL");
    if (type != UpdateType::ALWAYS) args.push_back(detail::update_flag(type));
    return run<bool>(std::move(args));
  }
  // An integer TTL, in seconds (not real redis++, where it would mean KEEPTTL).
  template <class I>
    requires(std::is_integral_v<I> && !std::is_same_v<I, bool>)
  Ret<bool> set(const StringView& key, const StringView& val, I seconds, UpdateType type = UpdateType::ALWAYS) {
    return set(key, val, std::chrono::milliseconds(static_cast<long long>(seconds) * 1000), type);
  }
  Ret<bool> setnx(const StringView& key, const StringView& val) { return run<bool>(detail::cmd("SETNX", key, val)); }
  Ret<void> setex(const StringView& key, long long ttl, const StringView& val) {
    return run<void>(detail::cmd("SETEX", key, ttl, val));
  }
  Ret<void> setex(const StringView& key, const std::chrono::seconds& ttl, const StringView& val) {
    return setex(key, ttl.count(), val);
  }
  Ret<void> psetex(const StringView& key, long long ttl, const StringView& val) {
    return run<void>(detail::cmd("PSETEX", key, ttl, val));
  }
  Ret<void> psetex(const StringView& key, const std::chrono::milliseconds& ttl, const StringView& val) {
    return psetex(key, ttl.count(), val);
  }
  Ret<OptionalString> getset(const StringView& key, const StringView& val) {
    return run<OptionalString>(detail::cmd("GETSET", key, val));
  }
  Ret<OptionalString> getdel(const StringView& key) { return run<OptionalString>(detail::cmd("GETDEL", key)); }
  Ret<long long> incr(const StringView& key) { return run<long long>(detail::cmd("INCR", key)); }
  // INCR by n (not real redis++: incrby).
  Ret<long long> incr(const StringView& key, long long n) { return incrby(key, n); }
  Ret<long long> incrby(const StringView& key, long long n) { return run<long long>(detail::cmd("INCRBY", key, n)); }
  Ret<double> incrbyfloat(const StringView& key, double n) { return run<double>(detail::cmd("INCRBYFLOAT", key, n)); }
  Ret<long long> decr(const StringView& key) { return run<long long>(detail::cmd("DECR", key)); }
  Ret<long long> decrby(const StringView& key, long long n) { return run<long long>(detail::cmd("DECRBY", key, n)); }
  Ret<long long> append(const StringView& key, const StringView& val) {
    return run<long long>(detail::cmd("APPEND", key, val));
  }
  Ret<long long> strlen(const StringView& key) { return run<long long>(detail::cmd("STRLEN", key)); }
  Ret<long long> setrange(const StringView& key, long long offset, const StringView& val) {
    return run<long long>(detail::cmd("SETRANGE", key, offset, val));
  }
  Ret<std::string> getrange(const StringView& key, long long start, long long end) {
    return run<std::string>(detail::cmd("GETRANGE", key, start, end));
  }
  template <detail::iterator Input>
  Ret<void> mset(Input first, Input last) {
    return run<void>(detail::join({"MSET"}, detail::range_args(first, last)));
  }
  template <class T>
  Ret<void> mset(std::initializer_list<T> il) {
    return mset(il.begin(), il.end());
  }
  template <detail::iterator Input>
  Ret<bool> msetnx(Input first, Input last) {
    return run<bool>(detail::join({"MSETNX"}, detail::range_args(first, last)));
  }

  // ---- hashes
  Ret<long long> hset(const StringView& key, const StringView& field, const StringView& val) {
    return run<long long>(detail::cmd("HSET", key, field, val));
  }
  Ret<long long> hset(const StringView& key, const std::pair<StringView, StringView>& item) {
    return hset(key, item.first, item.second);
  }
  template <detail::iterator Input>
  Ret<long long> hset(const StringView& key, Input first, Input last) {
    return run<long long>(detail::join(detail::cmd("HSET", key), detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> hset(const StringView& key, std::initializer_list<T> il) {
    return hset(key, il.begin(), il.end());
  }
  // Braced pairs, {{"field", value}, …}.
  Ret<long long> hset(const StringView& key, std::initializer_list<std::pair<detail::Arg, detail::Arg>> il) {
    std::vector<std::string> args = detail::cmd("HSET", key);
    for (const auto& [f, v] : il) {
      args.push_back(f.text);
      args.push_back(v.text);
    }
    return run<long long>(std::move(args));
  }
  // Fields and values in turn (not real redis++).
  template <class... Rest>
    requires(sizeof...(Rest) >= 2 && sizeof...(Rest) % 2 == 0)
  Ret<long long> hset(const StringView& key, const StringView& field, const StringView& val, const Rest&... rest) {
    std::vector<std::string> args = detail::cmd("HSET", key, field, val);
    (args.push_back(detail::Arg(rest).text), ...);
    return run<long long>(std::move(args));
  }
  Ret<bool> hsetnx(const StringView& key, const StringView& field, const StringView& val) {
    return run<bool>(detail::cmd("HSETNX", key, field, val));
  }
  template <detail::iterator Input>
  Ret<void> hmset(const StringView& key, Input first, Input last) {
    return run<void>(detail::join(detail::cmd("HMSET", key), detail::range_args(first, last)));
  }
  template <class T>
  Ret<void> hmset(const StringView& key, std::initializer_list<T> il) {
    return hmset(key, il.begin(), il.end());
  }
  Ret<OptionalString> hget(const StringView& key, const StringView& field) {
    return run<OptionalString>(detail::cmd("HGET", key, field));
  }
  Ret<long long> hdel(const StringView& key, const StringView& field) {
    return run<long long>(detail::cmd("HDEL", key, field));
  }
  template <detail::iterator Input>
  Ret<long long> hdel(const StringView& key, Input first, Input last) {
    return run<long long>(detail::join(detail::cmd("HDEL", key), detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> hdel(const StringView& key, std::initializer_list<T> il) {
    return hdel(key, il.begin(), il.end());
  }
  Ret<bool> hexists(const StringView& key, const StringView& field) {
    return run<bool>(detail::cmd("HEXISTS", key, field));
  }
  Ret<long long> hincrby(const StringView& key, const StringView& field, long long n) {
    return run<long long>(detail::cmd("HINCRBY", key, field, n));
  }
  Ret<double> hincrbyfloat(const StringView& key, const StringView& field, double n) {
    return run<double>(detail::cmd("HINCRBYFLOAT", key, field, n));
  }
  Ret<long long> hlen(const StringView& key) { return run<long long>(detail::cmd("HLEN", key)); }
  Ret<long long> hstrlen(const StringView& key, const StringView& field) {
    return run<long long>(detail::cmd("HSTRLEN", key, field));
  }

  // ---- lists
  Ret<long long> lpush(const StringView& key, const StringView& val) {
    return run<long long>(detail::cmd("LPUSH", key, val));
  }
  template <detail::iterator Input>
  Ret<long long> lpush(const StringView& key, Input first, Input last) {
    return run<long long>(detail::join(detail::cmd("LPUSH", key), detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> lpush(const StringView& key, std::initializer_list<T> il) {
    return lpush(key, il.begin(), il.end());
  }
  Ret<long long> lpushx(const StringView& key, const StringView& val) {
    return run<long long>(detail::cmd("LPUSHX", key, val));
  }
  Ret<long long> rpush(const StringView& key, const StringView& val) {
    return run<long long>(detail::cmd("RPUSH", key, val));
  }
  template <detail::iterator Input>
  Ret<long long> rpush(const StringView& key, Input first, Input last) {
    return run<long long>(detail::join(detail::cmd("RPUSH", key), detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> rpush(const StringView& key, std::initializer_list<T> il) {
    return rpush(key, il.begin(), il.end());
  }
  Ret<long long> rpushx(const StringView& key, const StringView& val) {
    return run<long long>(detail::cmd("RPUSHX", key, val));
  }
  Ret<OptionalString> lpop(const StringView& key) { return run<OptionalString>(detail::cmd("LPOP", key)); }
  Ret<OptionalString> rpop(const StringView& key) { return run<OptionalString>(detail::cmd("RPOP", key)); }
  Ret<OptionalString> rpoplpush(const StringView& source, const StringView& destination) {
    return run<OptionalString>(detail::cmd("RPOPLPUSH", source, destination));
  }
  Ret<long long> llen(const StringView& key) { return run<long long>(detail::cmd("LLEN", key)); }
  Ret<OptionalString> lindex(const StringView& key, long long index) {
    return run<OptionalString>(detail::cmd("LINDEX", key, index));
  }
  Ret<long long> linsert(const StringView& key, InsertPosition position, const StringView& pivot,
                         const StringView& val) {
    return run<long long>(
        detail::cmd("LINSERT", key, position == InsertPosition::BEFORE ? "BEFORE" : "AFTER", pivot, val));
  }
  Ret<void> ltrim(const StringView& key, long long start, long long stop) {
    return run<void>(detail::cmd("LTRIM", key, start, stop));
  }
  Ret<long long> lrem(const StringView& key, long long count, const StringView& val) {
    return run<long long>(detail::cmd("LREM", key, count, val));
  }
  Ret<void> lset(const StringView& key, long long index, const StringView& val) {
    return run<void>(detail::cmd("LSET", key, index, val));
  }

  // ---- sets
  Ret<long long> sadd(const StringView& key, const StringView& member) {
    return run<long long>(detail::cmd("SADD", key, member));
  }
  template <detail::iterator Input>
  Ret<long long> sadd(const StringView& key, Input first, Input last) {
    return run<long long>(detail::join(detail::cmd("SADD", key), detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> sadd(const StringView& key, std::initializer_list<T> il) {
    return sadd(key, il.begin(), il.end());
  }
  Ret<long long> srem(const StringView& key, const StringView& member) {
    return run<long long>(detail::cmd("SREM", key, member));
  }
  template <detail::iterator Input>
  Ret<long long> srem(const StringView& key, Input first, Input last) {
    return run<long long>(detail::join(detail::cmd("SREM", key), detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> srem(const StringView& key, std::initializer_list<T> il) {
    return srem(key, il.begin(), il.end());
  }
  Ret<bool> sismember(const StringView& key, const StringView& member) {
    return run<bool>(detail::cmd("SISMEMBER", key, member));
  }
  Ret<long long> scard(const StringView& key) { return run<long long>(detail::cmd("SCARD", key)); }
  Ret<OptionalString> spop(const StringView& key) { return run<OptionalString>(detail::cmd("SPOP", key)); }
  Ret<OptionalString> srandmember(const StringView& key) {
    return run<OptionalString>(detail::cmd("SRANDMEMBER", key));
  }
  Ret<bool> smove(const StringView& source, const StringView& destination, const StringView& member) {
    return run<bool>(detail::cmd("SMOVE", source, destination, member));
  }

  // ---- sorted sets
  Ret<long long> zadd(const StringView& key, const StringView& member, double score,
                      UpdateType type = UpdateType::ALWAYS, bool changed = false) {
    std::vector<std::string> args = detail::cmd("ZADD", key);
    if (type != UpdateType::ALWAYS) args.push_back(detail::update_flag(type));
    if (changed) args.push_back("CH");
    args.push_back(detail::number(score));
    args.emplace_back(member);
    return run<long long>(std::move(args));
  }
  // Score before member, as ZADD itself orders them (not real redis++).
  Ret<long long> zadd(const StringView& key, double score, const StringView& member,
                      UpdateType type = UpdateType::ALWAYS, bool changed = false) {
    return zadd(key, member, score, type, changed);
  }
  // Members and scores (pairs of member, score, as redis++ takes them).
  template <detail::iterator Input>
  Ret<long long> zadd(const StringView& key, Input first, Input last, UpdateType type = UpdateType::ALWAYS,
                      bool changed = false) {
    std::vector<std::string> args = detail::cmd("ZADD", key);
    if (type != UpdateType::ALWAYS) args.push_back(detail::update_flag(type));
    if (changed) args.push_back("CH");
    for (; first != last; ++first) {
      args.push_back(detail::number(first->second));
      detail::add(args, first->first);
    }
    return run<long long>(std::move(args));
  }
  template <class T>
  Ret<long long> zadd(const StringView& key, std::initializer_list<T> il, UpdateType type = UpdateType::ALWAYS,
                      bool changed = false) {
    return zadd(key, il.begin(), il.end(), type, changed);
  }
  Ret<double> zincrby(const StringView& key, double increment, const StringView& member) {
    return run<double>(detail::cmd("ZINCRBY", key, increment, member));
  }
  Ret<long long> zrem(const StringView& key, const StringView& member) {
    return run<long long>(detail::cmd("ZREM", key, member));
  }
  template <detail::iterator Input>
  Ret<long long> zrem(const StringView& key, Input first, Input last) {
    return run<long long>(detail::join(detail::cmd("ZREM", key), detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> zrem(const StringView& key, std::initializer_list<T> il) {
    return zrem(key, il.begin(), il.end());
  }
  Ret<OptionalDouble> zscore(const StringView& key, const StringView& member) {
    return run<OptionalDouble>(detail::cmd("ZSCORE", key, member));
  }
  Ret<OptionalLongLong> zrank(const StringView& key, const StringView& member) {
    return run<OptionalLongLong>(detail::cmd("ZRANK", key, member));
  }
  Ret<OptionalLongLong> zrevrank(const StringView& key, const StringView& member) {
    return run<OptionalLongLong>(detail::cmd("ZREVRANK", key, member));
  }
  Ret<long long> zcard(const StringView& key) { return run<long long>(detail::cmd("ZCARD", key)); }
  template <class Interval>
  Ret<long long> zcount(const StringView& key, const Interval& interval) {
    return run<long long>(detail::cmd("ZCOUNT", key, interval.lower(), interval.upper()));
  }
  template <class Interval>
  Ret<long long> zremrangebyscore(const StringView& key, const Interval& interval) {
    return run<long long>(detail::cmd("ZREMRANGEBYSCORE", key, interval.lower(), interval.upper()));
  }
  template <class Interval>
  Ret<long long> zremrangebylex(const StringView& key, const Interval& interval) {
    return run<long long>(detail::cmd("ZREMRANGEBYLEX", key, interval.lower(), interval.upper()));
  }
  Ret<long long> zremrangebyrank(const StringView& key, long long start, long long stop) {
    return run<long long>(detail::cmd("ZREMRANGEBYRANK", key, start, stop));
  }
  template <class Interval>
  Ret<long long> zlexcount(const StringView& key, const Interval& interval) {
    return run<long long>(detail::cmd("ZLEXCOUNT", key, interval.lower(), interval.upper()));
  }
  Ret<std::optional<std::pair<std::string, double>>> zpopmin(const StringView& key) {
    return run<std::optional<std::pair<std::string, double>>>(detail::cmd("ZPOPMIN", key));
  }
  Ret<std::optional<std::pair<std::string, double>>> zpopmax(const StringView& key) {
    return run<std::optional<std::pair<std::string, double>>>(detail::cmd("ZPOPMAX", key));
  }

  // ---- HyperLogLog
  Ret<bool> pfadd(const StringView& key, const StringView& element) {
    return run<bool>(detail::cmd("PFADD", key, element));
  }
  template <detail::iterator Input>
  Ret<bool> pfadd(const StringView& key, Input first, Input last) {
    return run<bool>(detail::join(detail::cmd("PFADD", key), detail::range_args(first, last)));
  }
  template <class T>
  Ret<bool> pfadd(const StringView& key, std::initializer_list<T> il) {
    return pfadd(key, il.begin(), il.end());
  }
  Ret<long long> pfcount(const StringView& key) { return run<long long>(detail::cmd("PFCOUNT", key)); }
  template <detail::iterator Input>
  Ret<long long> pfcount(Input first, Input last) {
    return run<long long>(detail::join({"PFCOUNT"}, detail::range_args(first, last)));
  }
  template <class T>
  Ret<long long> pfcount(std::initializer_list<T> il) {
    return pfcount(il.begin(), il.end());
  }

  // ---- geo
  Ret<long long> geoadd(const StringView& key, const std::tuple<StringView, double, double>& member) {
    return run<long long>(
        detail::cmd("GEOADD", key, std::get<1>(member), std::get<2>(member), std::string(std::get<0>(member))));
  }
  template <detail::iterator Input>
  Ret<long long> geoadd(const StringView& key, Input first, Input last) {
    std::vector<std::string> args = detail::cmd("GEOADD", key);
    for (; first != last; ++first) {
      args.push_back(detail::number(std::get<1>(*first)));
      args.push_back(detail::number(std::get<2>(*first)));
      detail::add(args, std::get<0>(*first));
    }
    return run<long long>(std::move(args));
  }
  template <class T>
  Ret<long long> geoadd(const StringView& key, std::initializer_list<T> il) {
    return geoadd(key, il.begin(), il.end());
  }
  Ret<OptionalDouble> geodist(const StringView& key, const StringView& a, const StringView& b,
                              GeoUnit unit = GeoUnit::M) {
    return run<OptionalDouble>(detail::cmd("GEODIST", key, a, b, detail::unit(unit)));
  }

  // ---- pub/sub
  Ret<long long> publish(const StringView& channel, const StringView& message) {
    return run<long long>(detail::cmd("PUBLISH", channel, message));
  }

  // ---- the generic command: redis.command<OptionalString>("GET", key); without a type, the hiredis reply
  template <class T = ReplyUPtr, class... Args>
  Ret<T> command(const StringView& name, const Args&... args) {
    return run<T>(detail::cmd(name, args...));
  }
  template <class T = ReplyUPtr, detail::iterator Input>
  Ret<T> command(Input first, Input last) {
    return run<T>(detail::range_args(first, last));
  }
};

class Pipeline;
class Transaction;
class Subscriber;

// SCAN all the way through, as an iterator (not real redis++: redis.scan_match(pattern)).
class ScanCursor {
 public:
  explicit ScanCursor(std::vector<std::string> keys) : keys_(std::move(keys)) {}
  explicit operator bool() const { return at_ < keys_.size(); }
  ScanCursor& operator++() {
    ++at_;
    return *this;
  }
  const std::string& operator*() const { return keys_[at_]; }
  const std::string* operator->() const { return &keys_[at_]; }
  auto begin() const { return keys_.begin() + static_cast<std::ptrdiff_t>(at_); }
  auto end() const { return keys_.end(); }

 private:
  std::vector<std::string> keys_;
  std::size_t at_ = 0;
};

class Redis : public Commands<Redis, Immediate> {
  using Base = Commands<Redis, Immediate>;

 public:
  explicit Redis(const std::string& uri = "tcp://127.0.0.1:6379");
  explicit Redis(const ConnectionOptions& options, const ConnectionPoolOptions& = {})
      : options_(options), watch_(std::make_shared<detail::WatchState>()) {}

  template <class T>
  T dispatch(std::vector<std::string> args) {
    const lb::Json reply = detail::execute(args);
    if constexpr (std::is_same_v<T, void>) {
      return;
    } else if constexpr (std::is_same_v<T, ReplyUPtr>) {
      return ReplyUPtr(detail::make_reply(reply, detail::status_command(args[0])));
    } else {
      return reply::parse<T>(reply);
    }
  }

  using Base::command;
  using Base::spop;
  using Base::zpopmax;
  using Base::zpopmin;

  // ---- output-iterator commands: the reply's elements written to output (and, not real
  // redis++, the same commands without an output return the result)
  template <detail::iterator Input, detail::output Output>
  void mget(Input first, Input last, Output output) {
    reply::to_output(detail::execute(detail::join({"MGET"}, detail::range_args(first, last))), output);
  }
  template <class T, detail::output Output>
  void mget(std::initializer_list<T> keys, Output output) {
    mget(keys.begin(), keys.end(), output);
  }
  template <detail::iterator Input>
  std::vector<OptionalString> mget(Input first, Input last) {
    std::vector<OptionalString> out;
    mget(first, last, std::back_inserter(out));
    return out;
  }
  std::vector<OptionalString> mget(std::initializer_list<StringView> keys) { return mget(keys.begin(), keys.end()); }
  template <detail::range C>
  std::vector<OptionalString> mget(const C& keys) {
    return mget(std::begin(keys), std::end(keys));
  }

  template <detail::output Output>
  void hgetall(const StringView& key, Output output) {
    reply::to_output(detail::execute(detail::cmd("HGETALL", key)), output);
  }
  std::unordered_map<std::string, std::string> hgetall(const StringView& key) {
    std::unordered_map<std::string, std::string> out;
    hgetall(key, std::inserter(out, out.end()));
    return out;
  }
  template <detail::output Output>
  void hkeys(const StringView& key, Output output) {
    reply::to_output(detail::execute(detail::cmd("HKEYS", key)), output);
  }
  std::vector<std::string> hkeys(const StringView& key) { return strings(detail::cmd("HKEYS", key)); }
  template <detail::output Output>
  void hvals(const StringView& key, Output output) {
    reply::to_output(detail::execute(detail::cmd("HVALS", key)), output);
  }
  std::vector<std::string> hvals(const StringView& key) { return strings(detail::cmd("HVALS", key)); }
  template <detail::iterator Input, detail::output Output>
  void hmget(const StringView& key, Input first, Input last, Output output) {
    reply::to_output(detail::execute(detail::join(detail::cmd("HMGET", key), detail::range_args(first, last))),
                     output);
  }
  template <class T, detail::output Output>
  void hmget(const StringView& key, std::initializer_list<T> il, Output output) {
    hmget(key, il.begin(), il.end(), output);
  }
  template <detail::iterator Input>
  std::vector<OptionalString> hmget(const StringView& key, Input first, Input last) {
    std::vector<OptionalString> out;
    hmget(key, first, last, std::back_inserter(out));
    return out;
  }
  std::vector<OptionalString> hmget(const StringView& key, std::initializer_list<StringView> fields) {
    return hmget(key, fields.begin(), fields.end());
  }
  template <detail::range C>
  std::vector<OptionalString> hmget(const StringView& key, const C& fields) {
    return hmget(key, std::begin(fields), std::end(fields));
  }
  template <detail::output Output>
  void lrange(const StringView& key, long long start, long long stop, Output output) {
    reply::to_output(detail::execute(detail::cmd("LRANGE", key, start, stop)), output);
  }
  std::vector<std::string> lrange(const StringView& key, long long start, long long stop) {
    return strings(detail::cmd("LRANGE", key, start, stop));
  }
  template <detail::output Output>
  void lpop(const StringView& key, long long count, Output output) {
    reply::to_output(detail::execute(detail::cmd("LPOP", key, count)), output);
  }
  template <detail::output Output>
  void rpop(const StringView& key, long long count, Output output) {
    reply::to_output(detail::execute(detail::cmd("RPOP", key, count)), output);
  }
  using Base::lpop;
  using Base::rpop;
  template <detail::output Output>
  void smembers(const StringView& key, Output output) {
    reply::to_output(detail::execute(detail::cmd("SMEMBERS", key)), output);
  }
  std::vector<std::string> smembers(const StringView& key) { return strings(detail::cmd("SMEMBERS", key)); }
  template <detail::output Output>
  void spop(const StringView& key, long long count, Output output) {
    reply::to_output(detail::execute(detail::cmd("SPOP", key, count)), output);
  }
  template <detail::output Output>
  void srandmember(const StringView& key, long long count, Output output) {
    reply::to_output(detail::execute(detail::cmd("SRANDMEMBER", key, count)), output);
  }
  using Base::srandmember;
  template <detail::iterator Input, detail::output Output>
  void sinter(Input first, Input last, Output output) {
    reply::to_output(detail::execute(detail::join({"SINTER"}, detail::range_args(first, last))), output);
  }
  template <class T, detail::output Output>
  void sinter(std::initializer_list<T> il, Output output) {
    sinter(il.begin(), il.end(), output);
  }
  template <detail::iterator Input, detail::output Output>
  void sunion(Input first, Input last, Output output) {
    reply::to_output(detail::execute(detail::join({"SUNION"}, detail::range_args(first, last))), output);
  }
  template <class T, detail::output Output>
  void sunion(std::initializer_list<T> il, Output output) {
    sunion(il.begin(), il.end(), output);
  }
  template <detail::iterator Input, detail::output Output>
  void sdiff(Input first, Input last, Output output) {
    reply::to_output(detail::execute(detail::join({"SDIFF"}, detail::range_args(first, last))), output);
  }
  template <class T, detail::output Output>
  void sdiff(std::initializer_list<T> il, Output output) {
    sdiff(il.begin(), il.end(), output);
  }
  template <detail::output Output>
  void keys(const StringView& pattern, Output output) {
    reply::to_output(detail::execute(detail::cmd("KEYS", pattern)), output);
  }
  std::vector<std::string> keys(const StringView& pattern) { return strings(detail::cmd("KEYS", pattern)); }

  // SCAN: writes the batch's keys to output; the next cursor (0 when done).
  template <detail::output Output>
  long long scan(long long cursor, const StringView& pattern, long long count, Output output) {
    const lb::Json r = detail::execute(detail::cmd("SCAN", cursor, "MATCH", pattern, "COUNT", count));
    reply::to_output(r[1], output);
    return reply::parse<long long>(r[0]);
  }
  template <detail::output Output>
  long long scan(long long cursor, const StringView& pattern, Output output) {
    return scan(cursor, pattern, 10, output);
  }
  template <detail::output Output>
  long long scan(long long cursor, long long count, Output output) {
    return scan(cursor, "*", count, output);
  }
  template <detail::output Output>
  long long scan(long long cursor, Output output) {
    return scan(cursor, "*", 10, output);
  }
  std::pair<long long, std::vector<std::string>> scan(long long cursor, const StringView& pattern = "*",
                                                      long long count = 10) {
    std::vector<std::string> keys;
    const long long next = scan(cursor, pattern, count, std::back_inserter(keys));
    return {next, std::move(keys)};
  }
  ScanCursor scan_match(const StringView& pattern, long long count = 100) {
    std::vector<std::string> keys;
    long long cursor = 0;
    do {
      cursor = scan(cursor, pattern, count, std::back_inserter(keys));
    } while (cursor != 0);
    return ScanCursor(std::move(keys));
  }
  template <detail::output Output>
  long long hscan(const StringView& key, long long cursor, const StringView& pattern, long long count, Output output) {
    const lb::Json r = detail::execute(detail::cmd("HSCAN", key, cursor, "MATCH", pattern, "COUNT", count));
    reply::to_output(r[1], output);
    return reply::parse<long long>(r[0]);
  }
  template <detail::output Output>
  long long hscan(const StringView& key, long long cursor, Output output) {
    return hscan(key, cursor, "*", 10, output);
  }
  template <detail::output Output>
  long long sscan(const StringView& key, long long cursor, const StringView& pattern, long long count, Output output) {
    const lb::Json r = detail::execute(detail::cmd("SSCAN", key, cursor, "MATCH", pattern, "COUNT", count));
    reply::to_output(r[1], output);
    return reply::parse<long long>(r[0]);
  }
  template <detail::output Output>
  long long sscan(const StringView& key, long long cursor, Output output) {
    return sscan(key, cursor, "*", 10, output);
  }

  // ZRANGE and ZREVRANGE: WITHSCORES when output takes (member, score) pairs, as in redis++.
  template <detail::output Output>
  void zrange(const StringView& key, long long start, long long stop, Output output) {
    zrange_impl("ZRANGE", key, start, stop, output);
  }
  std::vector<std::string> zrange(const StringView& key, long long start, long long stop) {
    return strings(detail::cmd("ZRANGE", key, start, stop));
  }
  template <detail::output Output>
  void zrevrange(const StringView& key, long long start, long long stop, Output output) {
    zrange_impl("ZREVRANGE", key, start, stop, output);
  }
  std::vector<std::string> zrevrange(const StringView& key, long long start, long long stop) {
    return strings(detail::cmd("ZREVRANGE", key, start, stop));
  }
  // Members with min <= score <= max, scores as numbers or Redis's bound syntax (not real redis++).
  std::vector<std::string> zrangebyscore(const StringView& key, const detail::Arg& min, const detail::Arg& max) {
    return strings(detail::cmd("ZRANGEBYSCORE", key, min.text, max.text));
  }
  template <class Interval, detail::output Output>
  void zrangebyscore(const StringView& key, const Interval& interval, Output output) {
    zbyscore("ZRANGEBYSCORE", key, interval.lower(), interval.upper(), nullptr, output);
  }
  template <class Interval, detail::output Output>
  void zrangebyscore(const StringView& key, const Interval& interval, const LimitOptions& opts, Output output) {
    zbyscore("ZRANGEBYSCORE", key, interval.lower(), interval.upper(), &opts, output);
  }
  template <class Interval, detail::output Output>
  void zrevrangebyscore(const StringView& key, const Interval& interval, Output output) {
    zbyscore("ZREVRANGEBYSCORE", key, interval.upper(), interval.lower(), nullptr, output);
  }
  template <class Interval, detail::output Output>
  void zrevrangebyscore(const StringView& key, const Interval& interval, const LimitOptions& opts, Output output) {
    zbyscore("ZREVRANGEBYSCORE", key, interval.upper(), interval.lower(), &opts, output);
  }
  template <class Interval, detail::output Output>
  void zrangebylex(const StringView& key, const Interval& interval, Output output) {
    reply::to_output(detail::execute(detail::cmd("ZRANGEBYLEX", key, interval.lower(), interval.upper())), output);
  }
  template <class Interval, detail::output Output>
  void zrangebylex(const StringView& key, const Interval& interval, const LimitOptions& opts, Output output) {
    reply::to_output(detail::execute(detail::cmd("ZRANGEBYLEX", key, interval.lower(), interval.upper(), "LIMIT",
                                                 opts.offset, opts.count)),
                     output);
  }
  template <detail::output Output>
  void zpopmin(const StringView& key, long long count, Output output) {
    reply::to_output(detail::execute(detail::cmd("ZPOPMIN", key, count)), output);
  }
  std::vector<std::pair<std::string, double>> zpopmin(const StringView& key, long long count) {
    std::vector<std::pair<std::string, double>> out;
    zpopmin(key, count, std::back_inserter(out));
    return out;
  }
  template <detail::output Output>
  void zpopmax(const StringView& key, long long count, Output output) {
    reply::to_output(detail::execute(detail::cmd("ZPOPMAX", key, count)), output);
  }
  std::vector<std::pair<std::string, double>> zpopmax(const StringView& key, long long count) {
    std::vector<std::pair<std::string, double>> out;
    zpopmax(key, count, std::back_inserter(out));
    return out;
  }

  // ---- geo: GEORADIUS's WITHDIST/WITHHASH/WITHCOORD follow the output's element type, as in
  // redis++: std::string, or a tuple of the member and any of double (distance), long long
  // (geohash), std::pair<double, double> (longitude, latitude).
  template <detail::output Output>
  void georadius(const StringView& key, const std::pair<double, double>& loc, double radius, GeoUnit unit,
                 long long count, bool asc, Output output) {
    std::vector<std::string> args =
        detail::cmd("GEORADIUS", key, loc.first, loc.second, radius, detail::unit(unit));
    geo_finish<Output>(args, count, asc);
    reply::to_output(detail::execute(args), output);
  }
  // GEORADIUS … STORE/STOREDIST destination: how many were stored.
  OptionalLongLong georadius(const StringView& key, const std::pair<double, double>& loc, double radius, GeoUnit unit,
                             const StringView& destination, bool store_dist, long long count) {
    return reply::parse<OptionalLongLong>(
        detail::execute(detail::cmd("GEORADIUS", key, loc.first, loc.second, radius, detail::unit(unit), "COUNT",
                                    count, store_dist ? "STOREDIST" : "STORE", destination)));
  }
  template <detail::output Output>
  void georadiusbymember(const StringView& key, const StringView& member, double radius, GeoUnit unit,
                         long long count, bool asc, Output output) {
    std::vector<std::string> args = detail::cmd("GEORADIUSBYMEMBER", key, member, radius, detail::unit(unit));
    geo_finish<Output>(args, count, asc);
    reply::to_output(detail::execute(args), output);
  }
  template <detail::iterator Input, detail::output Output>
  void geopos(const StringView& key, Input first, Input last, Output output) {
    reply::to_output(detail::execute(detail::join(detail::cmd("GEOPOS", key), detail::range_args(first, last))),
                     output);
  }
  template <class T, detail::output Output>
  void geopos(const StringView& key, std::initializer_list<T> il, Output output) {
    geopos(key, il.begin(), il.end(), output);
  }
  Optional<std::pair<double, double>> geopos(const StringView& key, const StringView& member) {
    return reply::parse<Optional<std::pair<double, double>>>(detail::execute(detail::cmd("GEOPOS", key, member))[0]);
  }
  template <detail::iterator Input, detail::output Output>
  void geohash(const StringView& key, Input first, Input last, Output output) {
    reply::to_output(detail::execute(detail::join(detail::cmd("GEOHASH", key), detail::range_args(first, last))),
                     output);
  }
  template <class T, detail::output Output>
  void geohash(const StringView& key, std::initializer_list<T> il, Output output) {
    geohash(key, il.begin(), il.end(), output);
  }

  // ---- scripting. Keys and arguments: braced lists (strings or numbers), containers, or iterator
  // pairs; Result optional (a ScriptReply), several Results make a tuple.
  std::string script_load(const StringView& script) {
    return reply::parse<std::string>(detail::execute(detail::cmd("SCRIPT", "LOAD", script)));
  }
  template <detail::iterator Input, detail::output Output>
  void script_exists(Input first, Input last, Output output) {
    reply::to_output(detail::execute(detail::join({"SCRIPT", "EXISTS"}, detail::range_args(first, last))), output);
  }
  bool script_exists(const StringView& sha) {
    return reply::parse<long long>(detail::execute(detail::cmd("SCRIPT", "EXISTS", sha))[0]) == 1;
  }
  void script_flush() { detail::execute(detail::cmd("SCRIPT", "FLUSH")); }

#define LB_REDIS_SCRIPT(NAME, CMD)                                                                              \
  template <class Result = detail::ScriptReply, class... More>                                                  \
  typename detail::script_result<Result, More...>::type NAME(const StringView& script, detail::Args keys,         \
                                                             detail::Args args) {                               \
    return script_run<Result, More...>(CMD, script, detail::arg_list(keys), detail::arg_list(args));            \
  }                                                                                                             \
  template <class Result = detail::ScriptReply, class... More, detail::range K>                                 \
  typename detail::script_result<Result, More...>::type NAME(const StringView& script, const K& keys,           \
                                                             detail::Args args) {                               \
    return script_run<Result, More...>(CMD, script, detail::arg_list(keys), detail::arg_list(args));            \
  }                                                                                                             \
  template <class Result = detail::ScriptReply, class... More, detail::range A>                                 \
  typename detail::script_result<Result, More...>::type NAME(const StringView& script, detail::Args keys,         \
                                                             const A& args) {                                   \
    return script_run<Result, More...>(CMD, script, detail::arg_list(keys), detail::arg_list(args));            \
  }                                                                                                             \
  template <class Result = detail::ScriptReply, class... More, detail::range K, detail::range A>                \
  typename detail::script_result<Result, More...>::type NAME(const StringView& script, const K& keys,           \
                                                             const A& args) {                                   \
    return script_run<Result, More...>(CMD, script, detail::arg_list(keys), detail::arg_list(args));            \
  }                                                                                                             \
  template <class Result = detail::ScriptReply, class... More, detail::iterator K, detail::iterator A>          \
  typename detail::script_result<Result, More...>::type NAME(const StringView& script, K keys_first, K keys_last, \
                                                             A args_first, A args_last) {                       \
    return script_run<Result, More...>(CMD, script, detail::arg_list(keys_first, keys_last),                    \
                                       detail::arg_list(args_first, args_last));                                \
  }                                                                                                             \
  template <class Result = detail::ScriptReply, class... More, detail::iterator A>                              \
  typename detail::script_result<Result, More...>::type NAME(const StringView& script, detail::Args keys,         \
                                                             A args_first, A args_last) {                       \
    return script_run<Result, More...>(CMD, script, detail::arg_list(keys), detail::arg_list(args_first, args_last)); \
  }                                                                                                             \
  template <detail::output Output>                                                                              \
  void NAME(const StringView& script, detail::Args keys, detail::Args args, Output output) {                    \
    reply::to_output(detail::execute(detail::script_cmd(CMD, script, detail::arg_list(keys), detail::arg_list(args))), \
                     output);                                                                                   \
  }                                                                                                             \
  template <detail::range K, detail::output Output>                                                             \
  void NAME(const StringView& script, const K& keys, detail::Args args, Output output) {                        \
    reply::to_output(detail::execute(detail::script_cmd(CMD, script, detail::arg_list(keys), detail::arg_list(args))), \
                     output);                                                                                   \
  }                                                                                                             \
  template <detail::range A, detail::output Output>                                                             \
  void NAME(const StringView& script, detail::Args keys, const A& args, Output output) {                        \
    reply::to_output(detail::execute(detail::script_cmd(CMD, script, detail::arg_list(keys), detail::arg_list(args))), \
                     output);                                                                                   \
  }                                                                                                             \
  template <detail::range K, detail::range A, detail::output Output>                                            \
  void NAME(const StringView& script, const K& keys, const A& args, Output output) {                            \
    reply::to_output(detail::execute(detail::script_cmd(CMD, script, detail::arg_list(keys), detail::arg_list(args))), \
                     output);                                                                                   \
  }                                                                                                             \
  template <detail::iterator K, detail::iterator A, detail::output Output>                                      \
  void NAME(const StringView& script, K keys_first, K keys_last, A args_first, A args_last, Output output) {    \
    reply::to_output(detail::execute(detail::script_cmd(CMD, script, detail::arg_list(keys_first, keys_last),   \
                                                        detail::arg_list(args_first, args_last))),              \
                     output);                                                                                   \
  }

  LB_REDIS_SCRIPT(eval, "EVAL")
  LB_REDIS_SCRIPT(evalsha, "EVALSHA")
#undef LB_REDIS_SCRIPT

  // ---- transactions: WATCH keys, then a transaction's exec() throws WatchError (and runs
  // nothing) if any of them changed in between.
  void watch(const StringView& key) { detail::watch(*watch_, {std::string(key)}); }
  template <detail::iterator Input>
  void watch(Input first, Input last) {
    detail::watch(*watch_, detail::range_args(first, last));
  }
  template <class T>
  void watch(std::initializer_list<T> il) {
    watch(il.begin(), il.end());
  }
  void unwatch() { watch_->keys.clear(); }

  Pipeline pipeline(bool new_connection = true);
  Transaction transaction(bool piped = false, bool new_connection = true);
  Subscriber subscriber();
  // A Redis on the same connection (redis++'s redis(hash_tag) of a cluster; here: this one).
  Redis redis(const StringView& = "", bool = true) { return *this; }

  const ConnectionOptions& options() const { return options_; }

 private:
  friend class Transaction;
  Redis(const ConnectionOptions& options, std::shared_ptr<detail::WatchState> watch)
      : options_(options), watch_(std::move(watch)) {}

  static std::vector<std::string> strings(const std::vector<std::string>& args) {
    return reply::parse<std::vector<std::string>>(detail::execute(args));
  }
  template <class Result, class... More>
  static typename detail::script_result<Result, More...>::type script_run(const char* name, const StringView& script,
                                                                          const std::vector<std::string>& keys,
                                                                          const std::vector<std::string>& args) {
    return detail::script_parse<Result, More...>(detail::execute(detail::script_cmd(name, script, keys, args)));
  }
  template <class Output>
  static void geo_finish(std::vector<std::string>& args, long long count, bool asc) {
    for (auto& o : detail::geo_options<reply::element_t<Output>>()) args.push_back(std::move(o));
    if (count > 0) {
      args.push_back("COUNT");
      args.push_back(std::to_string(count));
    }
    args.push_back(asc ? "ASC" : "DESC");
  }
  template <class Output>
  void zrange_impl(const char* name, const StringView& key, long long start, long long stop, Output output) {
    using V = reply::element_t<Output>;
    std::vector<std::string> args = detail::cmd(name, key, start, stop);
    if constexpr (reply::is_pair<V>::value || reply::is_tuple<V>::value) args.push_back("WITHSCORES");
    reply::to_output(detail::execute(args), output);
  }
  template <class Output>
  void zbyscore(const char* name, const StringView& key, const std::string& from, const std::string& to,
                const LimitOptions* limit, Output output) {
    using V = reply::element_t<Output>;
    std::vector<std::string> args = detail::cmd(name, key, from, to);
    if constexpr (reply::is_pair<V>::value || reply::is_tuple<V>::value) args.push_back("WITHSCORES");
    if (limit != nullptr) {
      args.push_back("LIMIT");
      args.push_back(std::to_string(limit->offset));
      args.push_back(std::to_string(limit->count));
    }
    reply::to_output(detail::execute(args), output);
  }

  ConnectionOptions options_;
  std::shared_ptr<detail::WatchState> watch_;
};

// Commands queued, sent in one round trip by exec(): a pipeline, or with MULTI/EXEC a transaction.
template <class Self>
class Queued : public Commands<Self, Deferred<Self>> {
 public:
  template <class T>
  Self& dispatch(std::vector<std::string> args) {
    queued_.push_back(std::move(args));
    return static_cast<Self&>(*this);
  }

  // Output-iterator commands queue too; read them back with QueuedReplies::get(idx, output).
  template <detail::iterator Input>
  Self& mget(Input first, Input last) {
    return dispatch<void>(detail::join({"MGET"}, detail::range_args(first, last)));
  }
  template <class T>
  Self& mget(std::initializer_list<T> il) {
    return mget(il.begin(), il.end());
  }
  Self& hgetall(const StringView& key) { return dispatch<void>(detail::cmd("HGETALL", key)); }
  Self& hkeys(const StringView& key) { return dispatch<void>(detail::cmd("HKEYS", key)); }
  Self& hvals(const StringView& key) { return dispatch<void>(detail::cmd("HVALS", key)); }
  template <detail::iterator Input>
  Self& hmget(const StringView& key, Input first, Input last) {
    return dispatch<void>(detail::join(detail::cmd("HMGET", key), detail::range_args(first, last)));
  }
  template <class T>
  Self& hmget(const StringView& key, std::initializer_list<T> il) {
    return hmget(key, il.begin(), il.end());
  }
  Self& lrange(const StringView& key, long long start, long long stop) {
    return dispatch<void>(detail::cmd("LRANGE", key, start, stop));
  }
  Self& smembers(const StringView& key) { return dispatch<void>(detail::cmd("SMEMBERS", key)); }
  Self& keys(const StringView& pattern) { return dispatch<void>(detail::cmd("KEYS", pattern)); }
  Self& zrange(const StringView& key, long long start, long long stop, bool with_scores = false) {
    std::vector<std::string> args = detail::cmd("ZRANGE", key, start, stop);
    if (with_scores) args.push_back("WITHSCORES");
    return dispatch<void>(std::move(args));
  }
  Self& zrevrange(const StringView& key, long long start, long long stop, bool with_scores = false) {
    std::vector<std::string> args = detail::cmd("ZREVRANGE", key, start, stop);
    if (with_scores) args.push_back("WITHSCORES");
    return dispatch<void>(std::move(args));
  }
  template <class Interval>
  Self& zrangebyscore(const StringView& key, const Interval& interval, bool with_scores = false) {
    std::vector<std::string> args = detail::cmd("ZRANGEBYSCORE", key, interval.lower(), interval.upper());
    if (with_scores) args.push_back("WITHSCORES");
    return dispatch<void>(std::move(args));
  }
  template <class Interval>
  Self& zrangebyscore(const StringView& key, const Interval& interval, const LimitOptions& opts,
                      bool with_scores = false) {
    std::vector<std::string> args = detail::cmd("ZRANGEBYSCORE", key, interval.lower(), interval.upper());
    if (with_scores) args.push_back("WITHSCORES");
    args.insert(args.end(), {"LIMIT", std::to_string(opts.offset), std::to_string(opts.count)});
    return dispatch<void>(std::move(args));
  }
  template <class Interval>
  Self& zrevrangebyscore(const StringView& key, const Interval& interval, bool with_scores = false) {
    std::vector<std::string> args = detail::cmd("ZREVRANGEBYSCORE", key, interval.upper(), interval.lower());
    if (with_scores) args.push_back("WITHSCORES");
    return dispatch<void>(std::move(args));
  }
  template <class Interval>
  Self& zrevrangebyscore(const StringView& key, const Interval& interval, const LimitOptions& opts,
                         bool with_scores = false) {
    std::vector<std::string> args = detail::cmd("ZREVRANGEBYSCORE", key, interval.upper(), interval.lower());
    if (with_scores) args.push_back("WITHSCORES");
    args.insert(args.end(), {"LIMIT", std::to_string(opts.offset), std::to_string(opts.count)});
    return dispatch<void>(std::move(args));
  }
  using Commands<Self, Deferred<Self>>::zpopmin;
  using Commands<Self, Deferred<Self>>::zpopmax;
  using Commands<Self, Deferred<Self>>::spop;
  Self& zpopmin(const StringView& key, long long count) { return dispatch<void>(detail::cmd("ZPOPMIN", key, count)); }
  Self& zpopmax(const StringView& key, long long count) { return dispatch<void>(detail::cmd("ZPOPMAX", key, count)); }
  Self& spop(const StringView& key, long long count) { return dispatch<void>(detail::cmd("SPOP", key, count)); }
  Self& scan(long long cursor, const StringView& pattern = "*", long long count = 10) {
    return dispatch<void>(detail::cmd("SCAN", cursor, "MATCH", pattern, "COUNT", count));
  }
  Self& georadius(const StringView& key, const std::pair<double, double>& loc, double radius, GeoUnit unit,
                  long long count, bool asc, bool with_coord = false, bool with_dist = false, bool with_hash = false) {
    std::vector<std::string> args =
        detail::cmd("GEORADIUS", key, loc.first, loc.second, radius, detail::unit(unit));
    if (with_dist) args.push_back("WITHDIST");
    if (with_hash) args.push_back("WITHHASH");
    if (with_coord) args.push_back("WITHCOORD");
    if (count > 0) args.insert(args.end(), {"COUNT", std::to_string(count)});
    args.push_back(asc ? "ASC" : "DESC");
    return dispatch<void>(std::move(args));
  }

  Self& eval(const StringView& script, detail::Args keys, detail::Args args) {
    return dispatch<void>(detail::script_cmd("EVAL", script, detail::arg_list(keys), detail::arg_list(args)));
  }
  template <detail::range K, detail::range A>
  Self& eval(const StringView& script, const K& keys, const A& args) {
    return dispatch<void>(detail::script_cmd("EVAL", script, detail::arg_list(keys), detail::arg_list(args)));
  }
  template <detail::iterator K, detail::iterator A>
  Self& eval(const StringView& script, K keys_first, K keys_last, A args_first, A args_last) {
    return dispatch<void>(detail::script_cmd("EVAL", script, detail::arg_list(keys_first, keys_last),
                                             detail::arg_list(args_first, args_last)));
  }
  Self& evalsha(const StringView& sha, detail::Args keys, detail::Args args) {
    return dispatch<void>(detail::script_cmd("EVALSHA", sha, detail::arg_list(keys), detail::arg_list(args)));
  }
  template <detail::range K, detail::range A>
  Self& evalsha(const StringView& sha, const K& keys, const A& args) {
    return dispatch<void>(detail::script_cmd("EVALSHA", sha, detail::arg_list(keys), detail::arg_list(args)));
  }
  template <detail::iterator K, detail::iterator A>
  Self& evalsha(const StringView& sha, K keys_first, K keys_last, A args_first, A args_last) {
    return dispatch<void>(detail::script_cmd("EVALSHA", sha, detail::arg_list(keys_first, keys_last),
                                             detail::arg_list(args_first, args_last)));
  }

  void discard() { queued_.clear(); }

 protected:
  QueuedReplies send(const char* op) { return detail::send_queued(op, queued_); }

  std::vector<std::vector<std::string>> queued_;
};

class Pipeline : public Queued<Pipeline> {
 public:
  QueuedReplies exec() { return send("redis.pipeline"); }
};

class Transaction : public Queued<Transaction> {
 public:
  explicit Transaction(ConnectionOptions options = {},
                       std::shared_ptr<detail::WatchState> watch = std::make_shared<detail::WatchState>())
      : options_(std::move(options)), watch_(std::move(watch)) {}
  // MULTI … EXEC in one round trip; WatchError (nothing ran) if a key WATCHed through this
  // transaction's connection changed since.
  QueuedReplies exec();
  // A Redis on the transaction's connection: WATCH and read through it before queueing.
  Redis redis() { return Redis(options_, watch_); }

 private:
  ConnectionOptions options_;
  std::shared_ptr<detail::WatchState> watch_;
};

inline Pipeline Redis::pipeline(bool) { return Pipeline(); }
inline Transaction Redis::transaction(bool, bool) { return Transaction(options_, watch_); }

// A subscriber: its callbacks run inside consume(), one message per call.
class Subscriber {
 public:
  enum class MsgType { SUBSCRIBE, UNSUBSCRIBE, PSUBSCRIBE, PUNSUBSCRIBE, MESSAGE, PMESSAGE };
  using MessageCallback = std::function<void(std::string channel, std::string msg)>;
  using PatternCallback = std::function<void(std::string pattern, std::string channel, std::string msg)>;
  using MetaCallback = std::function<void(MsgType type, OptionalString channel, long long num)>;

  explicit Subscriber(std::chrono::milliseconds timeout = std::chrono::milliseconds(0))
      : state_(std::make_shared<State>()) {
    state_->timeout_ms = static_cast<double>(timeout.count());
  }

  void on_message(MessageCallback cb) { state_->on_message = std::move(cb); }
  void on_pmessage(PatternCallback cb) { state_->on_pmessage = std::move(cb); }
  void on_meta(MetaCallback cb) { state_->on_meta = std::move(cb); }
  template <class F>
  void on_error(F&&) {}

  void subscribe(const StringView& channel) { listen(std::string(channel), false); }
  template <detail::iterator Input>
  void subscribe(Input first, Input last) {
    for (; first != last; ++first) subscribe(*first);
  }
  template <class T>
  void subscribe(std::initializer_list<T> il) {
    subscribe(il.begin(), il.end());
  }
  void psubscribe(const StringView& pattern) { listen(std::string(pattern), true); }
  template <detail::iterator Input>
  void psubscribe(Input first, Input last) {
    for (; first != last; ++first) psubscribe(*first);
  }
  template <class T>
  void psubscribe(std::initializer_list<T> il) {
    psubscribe(il.begin(), il.end());
  }
  void unsubscribe();
  void unsubscribe(const StringView& channel);
  void punsubscribe();
  void punsubscribe(const StringView& pattern);

  // Wait for the next message (or meta event) and run its callback; TimeoutError once the
  // connection's socket_timeout passes without one.
  void consume();

 private:
  struct Event {
    MsgType type;
    std::string pattern, channel, message;
    long long num = 0;
  };
  struct State {
    MessageCallback on_message;
    PatternCallback on_pmessage;
    MetaCallback on_meta;
    std::vector<Event> inbox;
    std::vector<std::pair<std::string, bool>> subscribed;  // name, pattern
    std::vector<int> handles;                              // the server's subscription of each, in step
    lb::WaitQueue arrived;
    double timeout_ms = 0;
    ~State();  // the connection closes: the server drops every subscription left
  };

  void listen(const std::string& name, bool pattern);
  void forget(const std::string& name, bool pattern, bool all);

  std::shared_ptr<State> state_;
};

inline Subscriber Redis::subscriber() { return Subscriber(options_.socket_timeout); }

}  // namespace sw::redis
