// The harness's Postgres (ctx.DB, cppruntime/include/leetbuild/db.h) and harness::Any, the dynamic
// value its rows (and decoded JSON) are made of.
#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>
#include <pqxx/internal/lb_world.hxx>

#include <cmath>
#include <cstdlib>
#include <exception>

namespace harness {

namespace {

const Any& nil() {
  static const Any value;
  return value;
}

const std::string& empty_string() {
  static const std::string value;
  return value;
}

Any from_nlohmann(const nlohmann::json& j) {
  switch (j.type()) {
    case nlohmann::json::value_t::null: return Any();
    case nlohmann::json::value_t::boolean: return Any(j.get<bool>());
    case nlohmann::json::value_t::number_integer: return Any(static_cast<int64_t>(j.get<int64_t>()));
    case nlohmann::json::value_t::number_unsigned: {
      const uint64_t u = j.get<uint64_t>();
      if (u > static_cast<uint64_t>(INT64_MAX)) return Any(static_cast<double>(u));
      return Any(static_cast<int64_t>(u));
    }
    case nlohmann::json::value_t::number_float: return Any(j.get<double>());
    case nlohmann::json::value_t::string: return Any(j.get<std::string>());
    case nlohmann::json::value_t::array: {
      std::vector<Any> items;
      for (const auto& item : j) items.push_back(from_nlohmann(item));
      return Any(std::move(items));
    }
    case nlohmann::json::value_t::object: {
      std::map<std::string, Any> fields;
      for (const auto& [k, v] : j.items()) fields.emplace(k, from_nlohmann(v));
      return Any(std::move(fields));
    }
    default: return Any::Unsupported();
  }
}

// ---- Postgres text values, decoded the Go harness's way ----

constexpr unsigned kBool = 16, kBytea = 17, kInt8 = 20, kInt2 = 21, kInt4 = 23, kOid = 26, kJson = 114, kFloat4 = 700,
                   kFloat8 = 701, kJsonb = 3802;

// An array type's element type (0: not an array).
unsigned element_of(unsigned oid) {
  switch (oid) {
    case 1000: return kBool;
    case 1001: return kBytea;
    case 1005: return kInt2;
    case 1007: return kInt4;
    case 1016: return kInt8;
    case 1028: return kOid;
    case 1021: return kFloat4;
    case 1022: return kFloat8;
    case 199: return kJson;
    case 3807: return kJsonb;
    case 1009: return 25;    // text
    case 1015: return 1043;  // varchar
    case 1014: return 1042;  // bpchar
    case 1231: return 1700;  // numeric
    case 2951: return 2950;  // uuid
    case 1182: return 1082;  // date
    case 1115: return 1114;  // timestamp
    case 1185: return 1184;  // timestamptz
    default: return 0;
  }
}

Any decode(unsigned oid, const std::string& text);

// An array literal {a,"b c",NULL,{1,2}} from position at (its opening brace).
Any decode_array(unsigned elem, const std::string& s, size_t& at) {
  std::vector<Any> items;
  at++;  // '{'
  while (at < s.size() && s[at] != '}') {
    if (s[at] == '{') {
      items.push_back(decode_array(elem, s, at));
    } else if (s[at] == '"') {
      std::string v;
      at++;
      while (at < s.size() && s[at] != '"') {
        if (s[at] == '\\' && at + 1 < s.size()) at++;
        v += s[at++];
      }
      at++;
      items.push_back(decode(elem, v));
    } else {
      size_t end = at;
      while (end < s.size() && s[end] != ',' && s[end] != '}') end++;
      const std::string v = s.substr(at, end - at);
      items.push_back(v == "NULL" ? Any() : decode(elem, v));
      at = end;
    }
    if (at < s.size() && s[at] == ',') at++;
  }
  at++;  // '}'
  return Any(std::move(items));
}

Any decode(unsigned oid, const std::string& text) {
  if (const unsigned elem = element_of(oid)) {
    size_t at = text.find('{');
    if (at == std::string::npos) return Any(text);
    return decode_array(elem, text, at);
  }
  switch (oid) {
    case kBool: return Any(text == "t" || text == "true");
    case kInt8:
    case kInt2:
    case kInt4:
    case kOid: return Any(static_cast<int64_t>(std::strtoll(text.c_str(), nullptr, 10)));
    case kFloat4:
    case kFloat8: {
      if (text == "NaN") return Any(std::nan(""));
      if (text == "Infinity") return Any(HUGE_VAL);
      if (text == "-Infinity") return Any(-HUGE_VAL);
      return Any(std::strtod(text.c_str(), nullptr));
    }
    case kJson:
    case kJsonb: {
      if (auto v = ParseJSON(text)) return *v;
      return Any(text);
    }
    case kBytea: {
      if (text.rfind("\\x", 0) != 0) return Any(text);
      std::string out;
      for (size_t i = 2; i + 1 < text.size(); i += 2) {
        out += static_cast<char>(std::strtol(text.substr(i, 2).c_str(), nullptr, 16));
      }
      return Any(out);
    }
    default: return Any(text);
  }
}

Any logged(const lb::pg::Param& p) {
  if (!p.text) return Any();
  switch (p.kind) {
    case 'i': return Any(static_cast<int64_t>(std::strtoll(p.text->c_str(), nullptr, 10)));
    case 'f': return Any(std::strtod(p.text->c_str(), nullptr));
    case 'b': return Any(*p.text == "true");
    default: return Any(*p.text);
  }
}

std::string error_text(const std::map<std::string, std::string>& fields) {
  const auto it = fields.find("message");
  std::string out = it == fields.end() ? "database error" : it->second;
  if (fields.count("code") != 0) out = "pq: " + out;
  return out;
}

}  // namespace

// ---- Any ----

Any::Any(std::vector<Any> items) : kind_(Kind::Array), items_(std::make_shared<std::vector<Any>>(std::move(items))) {}

Any::Any(std::map<std::string, Any> fields)
    : kind_(Kind::Object), fields_(std::make_shared<std::map<std::string, Any>>(std::move(fields))) {}

Any Any::FromJson(const lb::Json& v) {
  switch (v.kind()) {
    case lb::Json::Kind::Null: return Any();
    case lb::Json::Kind::Bool: return Any(v.as_bool());
    case lb::Json::Kind::Number: {
      const double n = v.as_number();
      if (std::nearbyint(n) == n && std::fabs(n) < 9.2e18) return Any(static_cast<int64_t>(n));
      return Any(n);
    }
    case lb::Json::Kind::String: return Any(v.as_string());
    case lb::Json::Kind::Array: {
      std::vector<Any> items;
      for (const auto& item : v.items()) items.push_back(FromJson(item));
      return Any(std::move(items));
    }
    case lb::Json::Kind::Object: {
      std::map<std::string, Any> fields;
      for (const auto& [k, item] : v.fields()) fields.emplace(k, FromJson(item));
      return Any(std::move(fields));
    }
  }
  return Any();
}

int64_t Any::Int() const {
  if (kind_ == Kind::Int) return int_;
  if (kind_ == Kind::Float) return static_cast<int64_t>(float_);
  return 0;
}

double Any::Float() const {
  if (kind_ == Kind::Float) return float_;
  if (kind_ == Kind::Int) return static_cast<double>(int_);
  return 0;
}

const std::string& Any::String() const { return kind_ == Kind::String ? string_ : empty_string(); }

const std::vector<Any>& Any::Items() const {
  static const std::vector<Any> none;
  return kind_ == Kind::Array ? *items_ : none;
}

const std::map<std::string, Any>& Any::Fields() const {
  static const std::map<std::string, Any> none;
  return kind_ == Kind::Object ? *fields_ : none;
}

size_t Any::Len() const {
  if (kind_ == Kind::Array) return items_->size();
  if (kind_ == Kind::Object) return fields_->size();
  if (kind_ == Kind::String) return string_.size();
  return 0;
}

const Any& Any::operator[](const std::string& key) const {
  if (kind_ != Kind::Object) return nil();
  const auto it = fields_->find(key);
  return it == fields_->end() ? nil() : it->second;
}

const Any& Any::operator[](size_t i) const {
  if (kind_ != Kind::Array || i >= items_->size()) return nil();
  return (*items_)[i];
}

std::string Any::Format(bool quote) const {
  switch (kind_) {
    case Kind::Nil: return "<nil>";
    case Kind::Bool: return int_ != 0 ? "true" : "false";
    case Kind::Int: return std::to_string(int_);
    case Kind::Float: return FormatFloat(float_);
    case Kind::String: return quote ? Quote(string_) : string_;
    case Kind::Array: {
      std::string out = "[";
      bool first = true;
      for (const auto& item : *items_) {
        if (!first) out += ' ';
        first = false;
        out += item.Format(quote);
      }
      return out + "]";
    }
    case Kind::Object: {
      std::vector<std::pair<std::string, std::string>> items;
      for (const auto& [k, v] : *fields_) items.emplace_back(quote ? Quote(k) : k, v.Format(quote));
      return detail::sorted_map(std::move(items));
    }
    case Kind::Other: return "{?}";
  }
  return "";
}

bool Any::operator==(const Any& other) const {
  if (kind_ == Kind::Other || other.kind_ == Kind::Other) return false;
  if (IsNumber() && other.IsNumber()) {
    if (kind_ == Kind::Int && other.kind_ == Kind::Int) return int_ == other.int_;
    return static_cast<long double>(kind_ == Kind::Int ? int_ : float_) ==
           static_cast<long double>(other.kind_ == Kind::Int ? other.int_ : other.float_);
  }
  if (kind_ != other.kind_) return false;
  switch (kind_) {
    case Kind::Nil: return true;
    case Kind::Bool: return int_ == other.int_;
    case Kind::String: return string_ == other.string_;
    case Kind::Array: return *items_ == *other.items_;
    case Kind::Object: return *fields_ == *other.fields_;
    default: return false;
  }
}

std::optional<Any> ParseJSON(std::string_view text) {
  const nlohmann::json j = nlohmann::json::parse(text.begin(), text.end(), nullptr, false);
  if (j.is_discarded()) return std::nullopt;
  return from_nlohmann(j);
}

// ---- DB ----

void DB::Reset(const std::string& schema) {
  try {
    lb::pg::reset(schema);
  } catch (const std::exception& e) {
    ctx_.Fatalf("ctx.DB.Reset: %v", std::string(e.what()));
  }
}

std::tuple<std::vector<Row>, int64_t, std::optional<std::string>> DB::RunParams(const std::string& sql,
                                                                                const std::vector<lb::pg::Param>& args) {
  const lb::pg::Outcome out = lb::pg::run(sql, args, false, false);
  if (out.error) return {{}, 0, error_text(*out.error)};
  std::vector<Row> rows;
  rows.reserve(out.result.rows.size());
  for (const auto& cells : out.result.rows) {
    Row row;
    for (size_t i = 0; i < out.result.columns.size(); i++) {
      const auto& column = out.result.columns[i];
      row[column.name] = i < cells.size() && cells[i] ? decode(column.oid, *cells[i]) : Any();
    }
    rows.push_back(std::move(row));
  }
  const int64_t affected = out.result.affected >= 0 ? out.result.affected : static_cast<int64_t>(rows.size());
  return {std::move(rows), affected, std::nullopt};
}

std::vector<Row> DB::QueryParams(const std::string& sql, const std::vector<lb::pg::Param>& args) {
  auto [rows, affected, err] = RunParams(sql, args);
  if (err) ctx_.Fatalf("ctx.DB.Query(%q): %v", sql, *err);
  return rows;
}

int64_t DB::ExecParams(const std::string& sql, const std::vector<lb::pg::Param>& args) {
  auto [rows, affected, err] = RunParams(sql, args);
  if (err) ctx_.Fatalf("ctx.DB.Exec(%q): %v", sql, *err);
  return affected;
}

std::vector<std::string> DB::Events() { return lb::pg::events(); }

std::vector<DBQuery> DB::Queries() {
  std::vector<DBQuery> out;
  for (const auto& q : lb::pg::queries()) {
    DBQuery entry{q.sql, {}};
    for (const auto& p : q.params) entry.Args.push_back(logged(p));
    out.push_back(std::move(entry));
  }
  return out;
}

std::shared_ptr<DBProbe> DB::After(const std::string& pattern, std::function<void()> fn) {
  auto probe = std::make_shared<DBProbe>();
  lb::pg::after(pattern, [probe, fn = std::move(fn)] {
    probe->fired_ = true;
    try {
      fn();
    } catch (const Failure& f) {
      probe->recovered_ = f.message;
    } catch (const std::exception& e) {
      probe->recovered_ = std::string(e.what());
    } catch (...) {
      probe->recovered_ = CurrentExceptionType();
    }
  });
  return probe;
}

}  // namespace harness
