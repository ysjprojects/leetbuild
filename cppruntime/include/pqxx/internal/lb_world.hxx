// The database as the C++ runtime's models reach it: the shared PGlite behind the database bridge
// (src/lib/runtime/cpp/db.ts), one session behind a single-connection lock. Every statement of a
// program — the learner's pqxx and the harness's ctx.DB alike — passes through lb::pg::run, which
// keeps what the harness reads: the query log, BEGIN/COMMIT/ROLLBACK events, probes. Not part of
// libpqxx's API. Implemented in cppruntime/src/pqxx.cpp.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace lb::pg {

// One statement parameter: its Postgres text form (nullopt: NULL) and what C++ value it came from,
// for the query log: 'n' null, 'i' integer, 'f' floating, 'b' bool, 's' string, 'y' bytes, 'a' array.
struct Param {
  std::optional<std::string> text;
  char kind = 's';
};

struct Column {
  std::string name;
  unsigned oid = 0;
};

// What a statement returned, in Postgres text format (nullopt: NULL). affected: the rows an
// INSERT/UPDATE/DELETE changed, -1 when unknown.
struct Result {
  std::vector<Column> columns;
  std::vector<std::vector<std::optional<std::string>>> rows;
  long long affected = -1;
};

// A statement's outcome: its result, or the server's error fields (code, message, detail,
// constraint, table, …), or a failure of the runtime (no database) as {message}.
struct Outcome {
  Result result;
  std::optional<std::map<std::string, std::string>> error;
};

// Log, run, record the event, fire the probes it matches. held: the caller holds the connection
// (inside a transaction); counted: the learner's statement, not the harness's.
Outcome run(const std::string& sql, const std::vector<Param>& params, bool held, bool counted);
// Take the single connection (waits until it is free); its id, for release.
int hold();
void release(int id);
// Drop every table and apply schema (outside the lock and the logs).
void reset(const std::string& schema);

struct Logged {
  std::string sql;
  std::vector<Param> params;
};
std::vector<std::string> events();
std::vector<Logged> queries();
// Run fn once, right after the first statement containing pattern (case-insensitive) ran.
void after(const std::string& pattern, std::function<void()> fn);
// Empty the logs and drop the probes.
void clear();

// The text form of a floating value: the shortest digits that round-trip (what libpqxx sends).
std::string float_text(double v);
std::string float_text(float v);
// A text value inside a Postgres array literal: quoted, with \ and " escaped.
std::string array_element(std::string_view s);
// Bytes as bytea's hex text form, \x0102….
std::string bytea_text(std::string_view bytes);

// ---- C++ values as statement parameters ----------------------------------------------------------

template <class T>
struct is_optional : std::false_type {};
template <class T>
struct is_optional<std::optional<T>> : std::true_type {};

template <class T>
struct is_vector : std::false_type {};
template <class T, class A>
struct is_vector<std::vector<T, A>> : std::true_type {};

// A sequence of std::byte (pqxx::bytes, bytes_view, std::vector<std::byte>): a bytea.
template <class T, class = void>
struct is_byte_seq : std::false_type {};
template <class T>
struct is_byte_seq<T, std::void_t<typename T::value_type, decltype(std::declval<const T&>().data()),
                                  decltype(std::declval<const T&>().size())>>
    : std::is_same<typename T::value_type, std::byte> {};

template <class T>
Param to_param(const T& v);

template <class T>
std::string array_text(const std::vector<T>& items) {
  std::string out = "{";
  bool first = true;
  for (const auto& item : items) {
    if (!first) out += ',';
    first = false;
    const Param p = to_param(item);
    if (!p.text) out += "NULL";
    else if (p.kind == 'a' || p.kind == 'i' || p.kind == 'f') out += *p.text;
    else out += array_element(*p.text);
  }
  return out + "}";
}

template <class T>
Param to_param(const T& v) {
  using D = std::decay_t<T>;
  if constexpr (std::is_same_v<D, std::nullptr_t> || std::is_same_v<D, std::nullopt_t>) {
    return {std::nullopt, 'n'};
  } else if constexpr (is_optional<D>::value) {
    if (!v.has_value()) return {std::nullopt, 'n'};
    return to_param(*v);
  } else if constexpr (std::is_same_v<D, bool>) {
    return {std::string(v ? "true" : "false"), 'b'};
  } else if constexpr (std::is_same_v<D, char>) {
    return {std::string(1, v), 's'};
  } else if constexpr (std::is_enum_v<D>) {
    return {std::to_string(static_cast<long long>(v)), 'i'};
  } else if constexpr (std::is_integral_v<D>) {
    return {std::to_string(v), 'i'};
  } else if constexpr (std::is_floating_point_v<D>) {
    if constexpr (std::is_same_v<D, float>) return {float_text(v), 'f'};
    else return {float_text(static_cast<double>(v)), 'f'};
  } else if constexpr (is_byte_seq<D>::value) {
    return {bytea_text(std::string_view(reinterpret_cast<const char*>(v.data()), v.size())), 'y'};
  } else if constexpr (std::is_convertible_v<const D&, std::string_view>) {
    if constexpr (std::is_pointer_v<D>) {
      if (v == nullptr) return {std::nullopt, 'n'};
    }
    return {std::string(std::string_view(v)), 's'};
  } else if constexpr (is_vector<D>::value) {
    return {array_text(v), 'a'};
  } else if constexpr (requires { v.lb_param(); }) {
    return v.lb_param();
  } else {
    static_assert(sizeof(D) == 0, "this type cannot be a statement parameter");
  }
}

}  // namespace lb::pg
