// The harness's side of Postgres (ctx.DB): resetting the schema, its own statements (not counted as
// the learner's), the learner's statements as they ran, probes between them. The Go harness's DB
// API (goruntime/harness/db.go), over the shared PGlite through the runtime's database bridge
// (src/lib/runtime/cpp/db.ts). A transaction holds the single connection, so a harness statement
// issued meanwhile waits for its COMMIT/ROLLBACK. Implemented in cppruntime/src/harness_db.cpp.
//
//	ctx.DB.Reset(schema)               drop every table and apply schema; clears events, queries, probes
//	ctx.DB.Query(sql, args...)         rows as std::vector<Row> (column → value); fails the check on error
//	ctx.DB.Exec(sql, args...)          rows affected; fails the check on error
//	ctx.DB.Run(sql, args...)           {rows, affected, error}: a statement that may fail
//	ctx.DB.Events()                    "BEGIN" / "COMMIT" / "ROLLBACK" in order, as the database saw them
//	ctx.DB.Queries()                   every statement with its arguments, in order (learner's and harness's)
//	ctx.DB.After(pattern, fn)          run fn right after the first statement containing pattern
//
// Arguments are C++ values: integers, floating values, bool, strings, nullptr, std::optional of
// them, and std::vector, which goes as a Postgres array (`= ANY($1)`). Row values are harness::Any,
// Go's `any` as the Go harness decodes them: integers int64, floats double, bool, text/varchar/uuid
// string, numeric string, bytea string of the bytes, date/timestamp the text Postgres prints,
// json/jsonb decoded (objects, arrays, numbers …), arrays of their elements, NULL nil.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <tuple>
#include <utility>
#include <vector>

#include <pqxx/internal/lb_world.hxx>

namespace lb {
class Json;
}

namespace harness {

class Ctx;

// A dynamic value, Go's `any` as the harness meets it (a row's column, a decoded JSON document):
// nil, bool, int64, double, string, an array or an object of values. Compares with plain C++
// values by value (ctx.Equal(row["n"], 3), row["id"] == "o-1", ctx.Equal(row["sent_at"], nullptr))
// and prints the way Go's %v prints the value.
class Any {
 public:
  enum class Kind { Nil, Bool, Int, Float, String, Array, Object, Other };

  Any() = default;
  Any(std::nullptr_t) {}
  explicit Any(bool b) : kind_(Kind::Bool), int_(b) {}
  explicit Any(int64_t n) : kind_(Kind::Int), int_(n) {}
  explicit Any(double n) : kind_(Kind::Float), float_(n) {}
  explicit Any(std::string s) : kind_(Kind::String), string_(std::move(s)) {}
  explicit Any(std::vector<Any> items);
  explicit Any(std::map<std::string, Any> fields);

  // A C++ value as Any (numbers, strings, bool, nullptr, optionals, vectors, maps, lb::Json, Any).
  template <class T>
  static Any Of(const T& v);
  static Any FromJson(const lb::Json& v);
  // A value no C++ value equals (a type Any has no counterpart for).
  static Any Unsupported() {
    Any a;
    a.kind_ = Kind::Other;
    return a;
  }

  Kind kind() const { return kind_; }
  bool IsNil() const { return kind_ == Kind::Nil; }
  bool IsBool() const { return kind_ == Kind::Bool; }
  bool IsInt() const { return kind_ == Kind::Int; }
  bool IsFloat() const { return kind_ == Kind::Float; }
  bool IsNumber() const { return kind_ == Kind::Int || kind_ == Kind::Float; }
  bool IsString() const { return kind_ == Kind::String; }
  bool IsArray() const { return kind_ == Kind::Array; }
  bool IsObject() const { return kind_ == Kind::Object; }

  // The value as Go's type assertion with ok would give it: the zero value for another kind
  // (Int and Float convert between each other).
  bool Bool() const { return kind_ == Kind::Bool && int_ != 0; }
  int64_t Int() const;
  double Float() const;
  const std::string& String() const;
  const std::vector<Any>& Items() const;
  const std::map<std::string, Any>& Fields() const;
  size_t Len() const;
  // An object's field (nil when absent), an array's element (nil when out of range).
  const Any& operator[](const std::string& key) const;
  const Any& operator[](const char* key) const { return (*this)[std::string(key)]; }
  const Any& operator[](size_t i) const;
  const Any& operator[](int i) const { return (*this)[static_cast<size_t>(i)]; }

  // Go's %v of the value (with quote: %q, strings quoted at any depth).
  std::string Format(bool quote = false) const;

  // Equal by value: numbers across int and float, containers element by element.
  bool operator==(const Any& other) const;
  template <class T>
    requires(!std::is_same_v<std::decay_t<T>, Any>)
  bool operator==(const T& other) const {
    return *this == Of(other);
  }

 private:
  Kind kind_ = Kind::Nil;
  int64_t int_ = 0;
  double float_ = 0;
  std::string string_;
  std::shared_ptr<std::vector<Any>> items_;
  std::shared_ptr<std::map<std::string, Any>> fields_;
};

// The text as JSON, decoded the way encoding/json decodes into `any`; nullopt when it is not JSON.
std::optional<Any> ParseJSON(std::string_view text);

// One result row: column name → value.
using Row = std::map<std::string, Any>;

// One statement of the query log, with its arguments as the learner passed them (integers,
// floating values, bool, strings, nil; a vector as its Postgres array text "{a,b}").
struct DBQuery {
  std::string SQL;
  std::vector<Any> Args;
};

// A probe set with After.
class DBProbe {
 public:
  // Whether the probe ran.
  bool Fired() const { return fired_; }
  // What fn threw (a failed assertion's message, an exception's what()), nullopt if it returned.
  const std::optional<std::string>& Recovered() const { return recovered_; }

 private:
  friend class DB;
  bool fired_ = false;
  std::optional<std::string> recovered_;
};

class DB {
 public:
  explicit DB(Ctx& ctx) : ctx_(ctx) {}

  // Drop every table, apply schema (DDL) and clear the events, the query log and the probes.
  void Reset(const std::string& schema);

  // One statement (autocommit), without failing the check: its rows, the rows it affected (the
  // rows it returned, for a SELECT) and its error, if any.
  template <class... A>
  std::tuple<std::vector<Row>, int64_t, std::optional<std::string>> Run(const std::string& sql, const A&... args) {
    return RunParams(sql, {lb::pg::to_param(args)...});
  }
  // One statement; its rows. An error fails the check.
  template <class... A>
  std::vector<Row> Query(const std::string& sql, const A&... args) {
    return QueryParams(sql, {lb::pg::to_param(args)...});
  }
  // One statement; the rows it affected. An error fails the check.
  template <class... A>
  int64_t Exec(const std::string& sql, const A&... args) {
    return ExecParams(sql, {lb::pg::to_param(args)...});
  }

  std::tuple<std::vector<Row>, int64_t, std::optional<std::string>> RunParams(const std::string& sql,
                                                                              const std::vector<lb::pg::Param>& args);
  std::vector<Row> QueryParams(const std::string& sql, const std::vector<lb::pg::Param>& args);
  int64_t ExecParams(const std::string& sql, const std::vector<lb::pg::Param>& args);

  // BEGIN / COMMIT / ROLLBACK, in order, for every such statement that succeeded since the check
  // began (or since Reset).
  std::vector<std::string> Events();
  // Every statement run since the check began (or since Reset), learner's and harness's, in
  // order, failed ones included.
  std::vector<DBQuery> Queries();
  // Run fn once, right after the first statement whose text contains pattern (case-insensitive)
  // has run, succeeded or failed, before its caller sees the outcome. fn runs on the learner's
  // thread; inside a transaction the connection is still held, so a ctx.DB statement in fn would
  // wait for the transaction — start it on a thread of its own (lb::spawn) to have it run right
  // after the transaction ends. What fn throws is the probe's Recovered(), not the learner's.
  std::shared_ptr<DBProbe> After(const std::string& pattern, std::function<void()> fn);

 private:
  Ctx& ctx_;
};

}  // namespace harness
