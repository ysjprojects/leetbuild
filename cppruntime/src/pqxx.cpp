// The database world (lb::pg: the statement path every statement of a program takes, the query log,
// events and probes) and the non-template half of the libpqxx model (cppruntime/include/pqxx/pqxx).
#include <pqxx/pqxx>

#include <lb/runtime.h>

#include <cctype>
#include <charconv>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cxxabi.h>

namespace lb::pg {

namespace {

struct Probe {
  std::string pattern;
  std::function<void()> fn;
  bool fired = false;
};

struct World {
  std::vector<std::string> events;
  std::vector<Logged> queries;
  std::vector<std::shared_ptr<Probe>> probes;
};

World& world() {
  static World w;
  return w;
}

std::string lower(std::string_view s) {
  std::string out(s);
  for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

bool starts_with(std::string_view s, std::string_view prefix) { return s.substr(0, prefix.size()) == prefix; }

// BEGIN / COMMIT / ROLLBACK, as pg.ts classifies statements.
const char* event_of(const std::string& sql) {
  size_t at = 0;
  while (at < sql.size() && std::isspace(static_cast<unsigned char>(sql[at]))) at++;
  std::string upper = sql.substr(at, 20);
  for (char& c : upper) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  if (starts_with(upper, "BEGIN") || starts_with(upper, "START TRANSACTION")) return "BEGIN";
  if (starts_with(upper, "COMMIT") || starts_with(upper, "END")) return "COMMIT";
  if (starts_with(upper, "ROLLBACK") || starts_with(upper, "ABORT")) return "ROLLBACK";
  return nullptr;
}

// The probes the statement matches run once each, on the statement's thread, before its caller
// sees the outcome; what they throw does not reach the caller.
void fire(const std::string& sql) {
  const std::string text = lower(sql);
  std::vector<std::shared_ptr<Probe>> due;
  for (const auto& p : world().probes) {
    if (!p->fired && text.find(p->pattern) != std::string::npos) {
      p->fired = true;
      due.push_back(p);
    }
  }
  for (const auto& p : due) {
    try {
      p->fn();
    } catch (...) {
    }
  }
}

}  // namespace

Outcome run(const std::string& sql, const std::vector<Param>& params, bool held, bool counted) {
  world().queries.push_back({sql, params});
  Json args = Json::array();
  for (const auto& p : params) args.push(p.text ? Json(*p.text) : Json());
  Json request = Json::object();
  request.set("sql", sql);
  request.set("args", args);
  request.set("held", held);
  request.set("counted", counted);
  const Json reply = call_async("db.run", request);
  Outcome out;
  if (reply.is_object() && reply.has("error")) {
    std::map<std::string, std::string> fields;
    for (const auto& [key, value] : reply["error"].fields()) {
      fields[key] = value.is_string() ? value.as_string() : value.dump();
    }
    out.error = std::move(fields);
  } else {
    for (const auto& f : reply["fields"].items()) {
      out.result.columns.push_back({f["name"].as_string(), static_cast<unsigned>(f["dataTypeID"].as_int())});
    }
    for (const auto& r : reply["rows"].items()) {
      std::vector<std::optional<std::string>> cells;
      cells.reserve(r.size());
      for (const auto& v : r.items()) {
        if (v.is_null()) cells.emplace_back(std::nullopt);
        else if (v.is_string()) cells.emplace_back(v.as_string());
        else cells.emplace_back(v.dump());
      }
      out.result.rows.push_back(std::move(cells));
    }
    out.result.affected = reply.has("affected") && reply["affected"].is_number() ? reply["affected"].as_int() : -1;
    if (const char* ev = event_of(sql)) world().events.emplace_back(ev);
  }
  fire(sql);
  return out;
}

int hold() { return static_cast<int>(call_async("db.hold").as_int()); }

void release(int id) { call("db.release", id); }

void reset(const std::string& schema) {
  clear();
  const Json reply = call_async("db.reset", schema);
  if (reply.is_string()) throw std::runtime_error(reply.as_string());
}

std::vector<std::string> events() { return world().events; }

std::vector<Logged> queries() { return world().queries; }

void after(const std::string& pattern, std::function<void()> fn) {
  world().probes.push_back(std::make_shared<Probe>(Probe{lower(pattern), std::move(fn)}));
}

void clear() {
  world().events.clear();
  world().queries.clear();
  world().probes.clear();
}

std::string float_text(double v) {
  if (v != v) return "NaN";
  if (v == __builtin_inf()) return "Infinity";
  if (v == -__builtin_inf()) return "-Infinity";
  char buf[64];
  const auto res = std::to_chars(buf, buf + sizeof buf, v);
  return std::string(buf, res.ptr);
}

std::string float_text(float v) {
  if (v != v || v == __builtin_inff() || v == -__builtin_inff()) return float_text(static_cast<double>(v));
  char buf[64];
  const auto res = std::to_chars(buf, buf + sizeof buf, v);
  return std::string(buf, res.ptr);
}

std::string array_element(std::string_view s) {
  std::string out = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') out += '\\';
    out += c;
  }
  return out + "\"";
}

std::string bytea_text(std::string_view bytes) {
  static const char* hex = "0123456789abcdef";
  std::string out = "\\x";
  for (unsigned char c : bytes) {
    out += hex[c >> 4];
    out += hex[c & 15];
  }
  return out;
}

}  // namespace lb::pg

namespace pqxx {

namespace internal {

std::string type_name(const char* mangled) {
  int status = 0;
  char* demangled = abi::__cxa_demangle(mangled, nullptr, nullptr, &status);
  if (demangled == nullptr) return mangled;
  std::string out(demangled);
  std::free(demangled);
  if (out == "std::__2::basic_string<char, std::__2::char_traits<char>, std::__2::allocator<char>>") return "std::string";
  return out;
}

long long parse_integer(std::string_view text, const char* type) {
  long long v = 0;
  const char* begin = text.data();
  const char* end = text.data() + text.size();
  while (begin < end && *begin == ' ') begin++;
  if (begin < end && *begin == '+') begin++;
  const auto res = std::from_chars(begin, end, v);
  if (res.ec == std::errc::result_out_of_range)
    throw conversion_overrun("Value out of range for " + std::string(type) + ": '" + std::string(text) + "'.");
  if (res.ec != std::errc() || res.ptr != end)
    throw conversion_error("Could not convert '" + std::string(text) + "' to " + type + ".");
  return v;
}

unsigned long long parse_unsigned(std::string_view text, const char* type) {
  unsigned long long v = 0;
  const char* begin = text.data();
  const char* end = text.data() + text.size();
  if (begin < end && *begin == '+') begin++;
  const auto res = std::from_chars(begin, end, v);
  if (res.ec == std::errc::result_out_of_range)
    throw conversion_overrun("Value out of range for " + std::string(type) + ": '" + std::string(text) + "'.");
  if (res.ec != std::errc() || res.ptr != end)
    throw conversion_error("Could not convert '" + std::string(text) + "' to " + type + ".");
  return v;
}

double parse_float(std::string_view text) {
  const std::string s(text);
  if (s == "NaN") return __builtin_nan("");
  if (s == "Infinity" || s == "infinity") return __builtin_inf();
  if (s == "-Infinity" || s == "-infinity") return -__builtin_inf();
  char* end = nullptr;
  const double v = std::strtod(s.c_str(), &end);
  if (s.empty() || end != s.c_str() + s.size())
    throw conversion_error("Could not convert string to numeric value: '" + s + "'.");
  return v;
}

bool parse_bool(std::string_view text) {
  std::string s(text);
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (s == "t" || s == "true" || s == "1" || s == "y" || s == "yes" || s == "on") return true;
  if (s == "f" || s == "false" || s == "0" || s == "n" || s == "no" || s == "off") return false;
  throw conversion_error("Failed conversion to bool: '" + std::string(text) + "'.");
}

std::string parse_bytea(std::string_view text) {
  if (text.substr(0, 2) != "\\x") return std::string(text);
  std::string out;
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    throw conversion_error("Invalid hex digit in bytea text.");
  };
  for (size_t i = 2; i + 1 < text.size(); i += 2) out += static_cast<char>(nibble(text[i]) << 4 | nibble(text[i + 1]));
  return out;
}

const char* begin_command(isolation_level level, write_policy rw) {
  const bool ro = rw == write_policy::read_only;
  switch (level) {
    case isolation_level::read_committed: return ro ? "BEGIN READ ONLY" : "BEGIN";
    case isolation_level::repeatable_read:
      return ro ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN ISOLATION LEVEL REPEATABLE READ";
    case isolation_level::serializable:
      return ro ? "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY" : "BEGIN ISOLATION LEVEL SERIALIZABLE";
  }
  return "BEGIN";
}

namespace {

// The server's error as libpqxx throws it: the exception class its SQLSTATE maps to.
[[noreturn]] void throw_sql_error(const std::map<std::string, std::string>& fields, const std::string& query) {
  const auto get = [&](const char* key) -> std::string {
    const auto it = fields.find(key);
    return it == fields.end() ? std::string() : it->second;
  };
  const std::string code = get("code");
  std::string what = get("severity");
  if (what.empty()) what = "ERROR";
  what += ":  " + get("message") + "\n";
  if (!get("detail").empty()) what += "DETAIL:  " + get("detail") + "\n";
  if (!get("hint").empty()) what += "HINT:  " + get("hint") + "\n";
  const char* state = code.c_str();
  if (code.empty()) throw broken_connection(get("message"));
  const std::string cls = code.substr(0, 2);
  if (cls == "08") throw broken_connection(what);
  if (cls == "0A") throw feature_not_supported(what, query, state);
  if (cls == "22") throw data_exception(what, query, state);
  if (cls == "23") {
    if (code == "23001") throw restrict_violation(what, query, state);
    if (code == "23502") throw not_null_violation(what, query, state);
    if (code == "23503") throw foreign_key_violation(what, query, state);
    if (code == "23505") throw unique_violation(what, query, state);
    if (code == "23514") throw check_violation(what, query, state);
    throw integrity_constraint_violation(what, query, state);
  }
  if (cls == "24") throw invalid_cursor_state(what, query, state);
  if (cls == "26") throw invalid_sql_statement_name(what, query, state);
  if (cls == "34") throw invalid_cursor_name(what, query, state);
  if (cls == "40") {
    if (code == "40000") throw transaction_rollback(what, query, state);
    if (code == "40001") throw serialization_failure(what, query, state);
    if (code == "40003") throw statement_completion_unknown(what, query, state);
    if (code == "40P01") throw deadlock_detected(what, query, state);
    throw transaction_rollback(what, query, state);
  }
  if (cls == "42") {
    if (code == "42501") throw insufficient_privilege(what, query, state);
    if (code == "42601") throw syntax_error(what, query, state);
    if (code == "42703") throw undefined_column(what, query, state);
    if (code == "42883") throw undefined_function(what, query, state);
    if (code == "42P01") throw undefined_table(what, query, state);
    throw sql_error(what, query, state);
  }
  if (cls == "53") {
    if (code == "53100") throw disk_full(what, query, state);
    if (code == "53200") throw out_of_memory(what, query, state);
    throw insufficient_resources(what, query, state);
  }
  if (cls == "P0") {
    if (code == "P0001") throw plpgsql_raise(what, query, state);
    if (code == "P0002") throw plpgsql_no_data_found(what, query, state);
    if (code == "P0003") throw plpgsql_too_many_rows(what, query, state);
    throw plpgsql_error(what, query, state);
  }
  throw sql_error(what, query, state);
}

}  // namespace

}  // namespace internal

// ---- results ----

void field::null_error(const std::string& type) const {
  throw conversion_error("Attempt to convert null to " + type + ".");
}

field row::at(int col) const {
  if (col < 0 || col >= size()) throw range_error("Invalid field number.");
  return (*this)[col];
}

int row::column_number(zview name) const {
  const auto& columns = data_->r.columns;
  for (size_t i = 0; i < columns.size(); i++) {
    if (columns[i].name == name) return static_cast<int>(i);
  }
  throw argument_error("Unknown column name: '" + std::string(name) + "'.");
}

void row::expect(int columns) const {
  if (size() != columns)
    throw usage_error("Tried to extract " + std::to_string(columns) + " field(s) from a row of " + std::to_string(size()) + ".");
}

row result::at(int index) const {
  if (index < 0 || index >= size()) throw range_error("Row number out of range.");
  return (*this)[index];
}

result::size_type result::affected_rows() const {
  return data_->r.affected >= 0 ? static_cast<int>(data_->r.affected) : size();
}

const char* result::column_name(row_size_type n) const {
  if (n < 0 || n >= columns()) throw range_error("Invalid column number: " + std::to_string(n) + ".");
  return data_->r.columns[static_cast<size_t>(n)].name.c_str();
}

row_size_type result::column_number(zview name) const {
  const auto& columns = data_->r.columns;
  for (size_t i = 0; i < columns.size(); i++) {
    if (columns[i].name == name) return static_cast<int>(i);
  }
  throw argument_error("Unknown column name: '" + std::string(name) + "'.");
}

oid result::column_type(row_size_type n) const {
  if (n < 0 || n >= columns()) throw range_error("Invalid column number: " + std::to_string(n) + ".");
  return data_->r.columns[static_cast<size_t>(n)].oid;
}

row result::one_row() const {
  if (size() != 1) throw unexpected_rows("Expected 1 row from query '" + query() + "', got " + std::to_string(size()) + ".");
  return front();
}

std::optional<row> result::opt_row() const {
  if (size() > 1)
    throw unexpected_rows("Expected at most 1 row from query '" + query() + "', got " + std::to_string(size()) + ".");
  if (empty()) return std::nullopt;
  return front();
}

field result::one_field() const {
  expect_columns(1);
  return one_row()[0];
}

void result::no_rows() const {
  if (!empty()) throw unexpected_rows("Expected no rows from query '" + query() + "', got " + std::to_string(size()) + ".");
}

result result::expect_rows(size_type n) const {
  if (size() != n)
    throw unexpected_rows("Expected " + std::to_string(n) + " row(s) from query '" + query() + "', got " +
                          std::to_string(size()) + ".");
  return *this;
}

result result::expect_columns(row_size_type n) const {
  if (columns() != n)
    throw usage_error("Expected " + std::to_string(n) + " column(s) from query '" + query() + "', got " +
                      std::to_string(columns()) + ".");
  return *this;
}

// ---- connections ----

const std::string& connection::lb_prepared(const std::string& name) const {
  const auto it = prepared_.find(name);
  if (it == prepared_.end())
    throw argument_error("Unknown prepared statement: '" + name + "'.");  // the server's 26000, as libpqxx reports it
  return it->second;
}

std::string connection::esc(std::string_view text) const {
  std::string out;
  out.reserve(text.size());
  for (char c : text) {
    if (c == '\'') out += '\'';
    out += c;
  }
  return out;
}

std::string connection::esc_raw(bytes_view data) const {
  return lb::pg::bytea_text(std::string_view(reinterpret_cast<const char*>(data.data()), data.size()));
}

std::string connection::quote_raw(bytes_view data) const { return "'" + esc_raw(data) + "'::bytea"; }

std::string connection::quote_name(std::string_view identifier) const {
  std::string out = "\"";
  for (char c : identifier) {
    if (c == '"') out += '"';
    out += c;
  }
  return out + "\"";
}

// ---- transactions ----

transaction_base::transaction_base(connection& c, std::string name, bool held, std::string begin)
    : conn_(c), name_(std::move(name)), held_(held) {
  if (c.lb_active != nullptr && c.lb_owner == lb_self())
    throw usage_error("Started new transaction while transaction was still active.");
  if (!held) return;
  hold_ = lb::pg::hold();
  c.lb_active = this;
  c.lb_owner = lb_self();
  const lb::pg::Outcome out = lb::pg::run(begin, {}, true, true);
  if (out.error) {
    c.lb_active = nullptr;
    lb::pg::release(hold_);
    done_ = true;
    internal::throw_sql_error(*out.error, begin);
  }
}

transaction_base::~transaction_base() = default;

void transaction_base::close() noexcept {
  if (done_) return;
  try {
    if (held_) end("ROLLBACK");
  } catch (...) {
  }
  done_ = true;
}

void transaction_base::end(const char* statement) {
  done_ = true;
  const lb::pg::Outcome out = lb::pg::run(statement, {}, true, true);
  conn_.lb_active = nullptr;
  conn_.lb_owner = 0;
  lb::pg::release(hold_);
  if (out.error) internal::throw_sql_error(*out.error, statement);
}

void transaction_base::commit() {
  if (done_) throw usage_error("Attempt to commit previously closed transaction.");
  if (!held_) {
    done_ = true;
    return;
  }
  end("COMMIT");
}

void transaction_base::abort() {
  if (done_) return;
  if (!held_) {
    done_ = true;
    return;
  }
  end("ROLLBACK");
}

result transaction_base::exec(std::string_view query, std::string_view) { return run(std::string(query), {}); }

result transaction_base::exec_n(result::size_type rows, std::string_view query, std::string_view desc) {
  return expect(rows, exec(query, desc));
}

result transaction_base::expect(result::size_type rows, const result& r) const {
  if (r.size() != rows)
    throw unexpected_rows("Expected " + std::to_string(rows) + " row(s) of data from query, got " + std::to_string(r.size()) +
                          ".");
  return r;
}

result transaction_base::run(const std::string& query, const std::vector<lb::pg::Param>& args) {
  if (done_) throw usage_error("Attempt to execute a query on a closed transaction.");
  if (!held_ && conn_.lb_active != nullptr && conn_.lb_owner == lb_self())
    throw usage_error("Started new transaction while transaction was still active.");
  lb::pg::Outcome out = lb::pg::run(query, args, held_, true);
  if (out.error) internal::throw_sql_error(*out.error, query);
  auto data = std::make_shared<internal::result_data>();
  data->r = std::move(out.result);
  data->query = query;
  return result(std::move(data));
}

}  // namespace pqxx
