// The harness's compiled half (cppruntime/include/leetbuild/harness.h): formatting, the harness's
// Redis client, HTTP in process, the program, the check runner.
#include <leetbuild/harness.h>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <typeinfo>

#include <cxxabi.h>

#include <lb/checks.h>
#include <sw/redis++/redis++.h>  // the Redis bridge's latin-1 pair (sw::redis::detail::to_bridge/from_bridge)

// The learner's main, as clang names it on WebAssembly: `int main()` defines __main_void; for
// `int main(int, char**)` (__main_argc_argv) libc's weak __main_void passes the program's arguments.
// Referenced only here: in the translation unit that defines main, a declaration of the name would
// make clang rename its own (__main_void.1) and leave this one to libc's.
extern "C" int __main_void(void);

namespace harness {

// ---- formatting --------------------------------------------------------------------------------

std::string Quote(std::string_view s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\a': out += "\\a"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\v': out += "\\v"; break;
      default:
        if (c < 0x20 || c == 0x7f) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\x%02x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out + "\"";
}

std::string FormatFloat(double v) {
  if (std::isnan(v)) return "NaN";
  if (std::isinf(v)) return v > 0 ? "+Inf" : "-Inf";
  if (v == 0) return std::signbit(v) ? "-0" : "0";
  char buf[64];
  auto [end, ec] = std::to_chars(buf, buf + sizeof buf, v, std::chars_format::scientific);
  const std::string sci(buf, end);
  const size_t e = sci.find('e');
  std::string mantissa = sci.substr(0, e);
  const int exp = std::atoi(sci.c_str() + e + 1);
  const bool negative = mantissa[0] == '-';
  if (negative) mantissa.erase(0, 1);
  std::string digits;
  for (char c : mantissa) {
    if (c != '.') digits += c;
  }
  const int nd = static_cast<int>(digits.size());
  const int dp = exp + 1;
  // Go's %v: %e form when the exponent is < -4 or >= the precision, 6 for the shortest form
  // unless fewer digits suffice and the point falls inside them.
  int eprec = 6;
  if (eprec > nd && nd >= dp) eprec = nd;
  std::string out;
  if (exp < -4 || exp >= eprec) {
    out = digits.substr(0, 1);
    if (nd > 1) out += "." + digits.substr(1);
    char ebuf[16];
    std::snprintf(ebuf, sizeof ebuf, "e%c%02d", exp < 0 ? '-' : '+', exp < 0 ? -exp : exp);
    out += ebuf;
  } else if (dp <= 0) {
    out = "0." + std::string(static_cast<size_t>(-dp), '0') + digits;
  } else if (dp >= nd) {
    out = digits + std::string(static_cast<size_t>(dp - nd), '0');
  } else {
    out = digits.substr(0, static_cast<size_t>(dp)) + "." + digits.substr(static_cast<size_t>(dp));
  }
  return negative ? "-" + out : out;
}

namespace detail {

std::string pointer(const void* p) {
  if (p == nullptr) return "<nil>";
  char buf[32];
  std::snprintf(buf, sizeof buf, "%p", p);
  return buf;
}

std::string sorted_map(std::vector<std::pair<std::string, std::string>> items) {
  std::sort(items.begin(), items.end());
  std::string out = "map[";
  bool first = true;
  for (const auto& [k, v] : items) {
    if (!first) out += ' ';
    first = false;
    out += k + ":" + v;
  }
  return out + "]";
}

std::string convert_integer(unsigned long long magnitude, bool negative, const Spec& spec) {
  char buf[80];
  switch (spec.verb) {
    case 'x':
      std::snprintf(buf, sizeof buf, "%llx", magnitude);
      break;
    case 'X':
      std::snprintf(buf, sizeof buf, "%llX", magnitude);
      break;
    case 'o':
      std::snprintf(buf, sizeof buf, "%llo", magnitude);
      break;
    case 'b': {
      std::string bits;
      for (unsigned long long m = magnitude; m > 0; m >>= 1) bits.insert(bits.begin(), static_cast<char>('0' + (m & 1)));
      return (negative ? "-" : "") + (bits.empty() ? std::string("0") : bits);
    }
    case 'c':
      return std::string(1, static_cast<char>(magnitude));
    case 'q':
      return "'" + std::string(1, static_cast<char>(magnitude)) + "'";
    case 'f':
    case 'F':
    case 'e':
    case 'g':
      return convert_float(negative ? -static_cast<double>(magnitude) : static_cast<double>(magnitude), spec);
    default:
      std::snprintf(buf, sizeof buf, "%llu", magnitude);
  }
  return (negative ? "-" : "") + std::string(buf);
}

std::string convert_float(double v, const Spec& spec) {
  char buf[512];
  switch (spec.verb) {
    case 'f':
    case 'F':
      std::snprintf(buf, sizeof buf, "%.*f", spec.precision < 0 ? 6 : spec.precision, v);
      return buf;
    case 'e':
      std::snprintf(buf, sizeof buf, "%.*e", spec.precision < 0 ? 6 : spec.precision, v);
      return buf;
    case 'g':
      if (spec.precision < 0) return FormatFloat(v);
      std::snprintf(buf, sizeof buf, "%.*g", spec.precision, v);
      return buf;
    default:
      return FormatFloat(v);
  }
}

std::string convert_string(std::string_view s, const Spec& spec) {
  switch (spec.verb) {
    case 'q':
      return Quote(s);
    case 'x':
    case 'X': {
      std::string out;
      for (unsigned char c : s) {
        char buf[4];
        std::snprintf(buf, sizeof buf, spec.verb == 'x' ? "%02x" : "%02X", c);
        out += buf;
      }
      return out;
    }
    default:
      if (spec.precision >= 0 && s.size() > static_cast<size_t>(spec.precision)) {
        return std::string(s.substr(0, static_cast<size_t>(spec.precision)));
      }
      return std::string(s);
  }
}

std::string pad(std::string text, const Spec& spec, bool numeric) {
  if (spec.plus && numeric && !text.empty() && text[0] != '-') text = "+" + text;
  if (spec.width > 0 && text.size() < static_cast<size_t>(spec.width)) {
    const size_t fill = static_cast<size_t>(spec.width) - text.size();
    if (spec.minus) {
      text += std::string(fill, ' ');
    } else if (spec.zero && numeric) {
      const size_t sign = !text.empty() && (text[0] == '-' || text[0] == '+') ? 1 : 0;
      text.insert(sign, std::string(fill, '0'));
    } else {
      text = std::string(fill, ' ') + text;
    }
  }
  return text;
}

std::string sprintf(std::string_view format, const Arg* args, size_t count) {
  std::string out;
  size_t next = 0;
  for (size_t i = 0; i < format.size(); i++) {
    const char c = format[i];
    if (c != '%') {
      out += c;
      continue;
    }
    if (i + 1 < format.size() && format[i + 1] == '%') {
      out += '%';
      i++;
      continue;
    }
    Spec spec;
    size_t j = i + 1;
    for (; j < format.size(); j++) {
      const char f = format[j];
      if (f == '-') spec.minus = true;
      else if (f == '+') spec.plus = true;
      else if (f == '0') spec.zero = true;
      else if (f == ' ') spec.space = true;
      else if (f == '#') spec.sharp = true;
      else break;
    }
    while (j < format.size() && format[j] >= '0' && format[j] <= '9') {
      spec.width = (spec.width < 0 ? 0 : spec.width * 10) + (format[j] - '0');
      j++;
    }
    if (j < format.size() && format[j] == '.') {
      j++;
      spec.precision = 0;
      while (j < format.size() && format[j] >= '0' && format[j] <= '9') {
        spec.precision = spec.precision * 10 + (format[j] - '0');
        j++;
      }
    }
    if (j >= format.size()) {
      out += "%!(NOVERB)";
      break;
    }
    spec.verb = format[j];
    i = j;
    if (next >= count) {
      out += "%!";
      out += spec.verb;
      out += "(MISSING)";
      continue;
    }
    out += pad(args[next].text(spec, args[next].value), spec, args[next].numeric);
    next++;
  }
  return out;
}

}  // namespace detail

// ---- the world ---------------------------------------------------------------------------------

void Clock::Advance(double seconds) { lb::call("clock.advance", seconds * 1000); }

int64_t Clock::Now() const { return static_cast<int64_t>(lb_now()); }

int Clock::Sleeps() const { return static_cast<int>(lb::call("clock.sleeps").as_int()); }

void Clock::SetSleepLimit(int n) { lb::call("clock.setSleepLimit", n); }

std::string Reply::String() const {
  if (v_.is_string()) return v_.as_string();
  if (v_.is_number()) return std::to_string(v_.as_int());
  return "";
}

long long Reply::Int() const {
  if (v_.is_number()) return v_.as_int();
  if (v_.is_string()) return std::atoll(v_.as_string().c_str());
  return 0;
}

double Reply::Float() const { return v_.is_number() ? v_.as_number() : std::atof(String().c_str()); }

std::vector<Reply> Reply::Array() const {
  std::vector<Reply> out;
  for (const auto& item : v_.items()) out.emplace_back(item);
  return out;
}

std::vector<std::string> Reply::Strings() const {
  std::vector<std::string> out;
  for (const auto& item : v_.items()) out.push_back(Reply(item).String());
  return out;
}

std::ostream& operator<<(std::ostream& out, const Reply& r) {
  if (r.IsNil()) return out << "<nil>";
  if (r.IsArray()) {
    out << '[';
    bool first = true;
    for (const auto& item : r.Array()) {
      if (!first) out << ' ';
      first = false;
      out << item;
    }
    return out << ']';
  }
  return out << r.String();
}

std::pair<Reply, std::optional<std::string>> Redis::Execute(const std::vector<std::string>& args) {
  const lb::Json list = sw::redis::detail::to_json(args);
  const lb::Json reply = sw::redis::detail::from_bridge(
      lb::call("redis.execute", lb::Json(std::map<std::string, lb::Json>{{"args", list}, {"record", false}})));
  if (reply.has("e")) return {Reply(), reply["e"].as_string()};
  return {Reply(reply["r"]), std::nullopt};
}

Reply Redis::Must(const std::vector<std::string>& args) {
  auto [reply, error] = Execute(args);
  if (error) {
    std::string cmd;
    for (const auto& a : args) cmd += (cmd.empty() ? "" : " ") + a;
    ctx_.Fatalf("redis %s: %s", cmd, *error);
  }
  return reply;
}

namespace {

std::optional<std::string> optional_string(const Reply& r) {
  if (r.IsNil()) return std::nullopt;
  return r.String();
}

std::vector<std::string> sorted(const Reply& r) {
  auto items = r.Strings();
  std::sort(items.begin(), items.end());
  return items;
}

std::vector<Redis::Z> pairs(const Reply& r) {
  std::vector<Redis::Z> out;
  const auto items = r.Strings();
  for (size_t i = 0; i + 1 < items.size(); i += 2) out.push_back({items[i], std::atof(items[i + 1].c_str())});
  return out;
}

}  // namespace

std::optional<std::string> Redis::Get(const std::string& key) { return optional_string(Must({"GET", key})); }

long long Redis::TTL(const std::string& key) { return Must({"TTL", key}).Int(); }

long long Redis::PTTL(const std::string& key) { return Must({"PTTL", key}).Int(); }

std::string Redis::Type(const std::string& key) { return Must({"TYPE", key}).String(); }

std::vector<std::string> Redis::Keys(const std::string& pattern) { return sorted(Must({"KEYS", pattern})); }

std::optional<std::string> Redis::HGet(const std::string& key, const std::string& field) {
  return optional_string(Must({"HGET", key, field}));
}

std::map<std::string, std::string> Redis::HGetAll(const std::string& key) {
  std::map<std::string, std::string> out;
  const auto items = Must({"HGETALL", key}).Strings();
  for (size_t i = 0; i + 1 < items.size(); i += 2) out[items[i]] = items[i + 1];
  return out;
}

long long Redis::HLen(const std::string& key) { return Must({"HLEN", key}).Int(); }

std::vector<std::string> Redis::LRange(const std::string& key, long long start, long long stop) {
  return Must({"LRANGE", key, std::to_string(start), std::to_string(stop)}).Strings();
}

long long Redis::LLen(const std::string& key) { return Must({"LLEN", key}).Int(); }

std::vector<std::string> Redis::SMembers(const std::string& key) { return sorted(Must({"SMEMBERS", key})); }

bool Redis::SIsMember(const std::string& key, const std::string& member) {
  return Must({"SISMEMBER", key, member}).Int() == 1;
}

long long Redis::SCard(const std::string& key) { return Must({"SCARD", key}).Int(); }

std::ostream& operator<<(std::ostream& out, const Redis::Z& z) {
  return out << '{' << z.Member << ' ' << FormatFloat(z.Score) << '}';
}

std::vector<Redis::Z> Redis::ZRangeWithScores(const std::string& key, long long start, long long stop) {
  return pairs(Must({"ZRANGE", key, std::to_string(start), std::to_string(stop), "WITHSCORES"}));
}

std::vector<Redis::Z> Redis::ZRevRangeWithScores(const std::string& key, long long start, long long stop) {
  return pairs(Must({"ZREVRANGE", key, std::to_string(start), std::to_string(stop), "WITHSCORES"}));
}

std::optional<double> Redis::ZScore(const std::string& key, const std::string& member) {
  const Reply r = Must({"ZSCORE", key, member});
  if (r.IsNil()) return std::nullopt;
  return r.Float();
}

long long Redis::ZCard(const std::string& key) { return Must({"ZCARD", key}).Int(); }

long long Redis::Publish(const std::string& channel, const std::string& message) {
  return Must({"PUBLISH", channel, message}).Int();
}

void Redis::After(const std::string& key, std::function<void()> fn) {
  lb::call("redis.probe",
           lb::Json(std::map<std::string, lb::Json>{{"key", sw::redis::detail::to_bridge(key)},
                                                    {"handle", lb::invocable(std::move(fn))}}));
}

void Redis::Subscribe(const std::string& channel,
                      std::function<void(const std::string& channel, const std::string& message)> fn) {
  const int handle = lb::receiver([fn = std::move(fn)](const std::string& payload) {
    const lb::Json m = sw::redis::detail::from_bridge(lb::Json::parse(payload));
    fn(m[1].as_string(), m[2].as_string());
  });
  lb::call("redis.subscribe",
           lb::Json(std::map<std::string, lb::Json>{
               {"name", sw::redis::detail::to_bridge(channel)}, {"pattern", false}, {"handle", handle}}));
}

std::vector<std::vector<std::string>> Redis::RoundTrips() {
  std::vector<std::vector<std::string>> out;
  const lb::Json trips = sw::redis::detail::from_bridge(lb::call("redis.trips"));  // held: items() refers into it
  for (const auto& trip : trips.items()) {
    std::vector<std::string> cmds;
    for (const auto& c : trip.items()) cmds.push_back(c.as_string());
    out.push_back(std::move(cmds));
  }
  return out;
}

lb::Json Response::JSON() const { return lb::Json::parse(Body); }

std::string Response::HeaderValue(const std::string& key) const {
  return httplib::get_header_value(Header, key, "", 0);
}

HTTP HTTP::From(const std::string& remote) const {
  HTTP h = *this;
  h.remote_ = remote;
  return h;
}

namespace {

httplib::Request make_request(const std::string& method, const std::string& path, const std::string& body,
                              const std::vector<std::string>& headers, const std::string& remote) {
  httplib::Request req;
  req.method = method;
  req.path = path;
  req.target = path;
  req.body = body;
  req.remote_addr = remote;
  for (size_t i = 0; i + 1 < headers.size(); i += 2) req.headers.emplace(headers[i], headers[i + 1]);
  if (!body.empty() && !req.has_header("Content-Type")) req.headers.emplace("Content-Type", "application/json");
  if (!body.empty()) req.headers.emplace("Content-Length", std::to_string(body.size()));
  return req;
}

Response response_of(httplib::Response res) { return Response{res.status, std::move(res.headers), std::move(res.body)}; }

}  // namespace

Response HTTP::Send(const std::string& method, const std::string& path, const std::string& body,
                    const std::vector<std::string>& headers) {
  return response_of(server_->handle(make_request(method, path, body, headers, remote_)));
}

std::function<Response()> HTTP::HoldRequest(const std::string& method, const std::string& path,
                                            const std::string& body, const std::vector<std::string>& headers) {
  auto finish = server_->hold(make_request(method, path, body, headers, remote_));
  return [finish = std::move(finish)] { return response_of(finish()); };
}

bool Program::Running() const { return !state_->done && !Exited().has_value(); }

std::optional<int> Program::Exited() const {
  if (state_->done) return state_->status;
  const lb::Json status = lb::call("program.exit");
  if (status.is_null()) return std::nullopt;
  return static_cast<int>(status.as_int());
}

std::vector<httplib::Server*> Program::Servers() const {
  std::vector<httplib::Server*> out;
  for (const auto& l : httplib::detail::listening()) out.push_back(l.server);
  return out;
}

bool Program::Listening() const { return !httplib::detail::listening().empty(); }

int Program::Signal(int sig) { return lb::deliver_signal(sig); }

std::string Program::describe() const {
  const auto& all = httplib::detail::listening();
  if (!all.empty()) {
    std::string ports;
    for (const auto& l : all) ports += (ports.empty() ? "" : ", ") + l.host + ":" + std::to_string(l.port);
    return "it listens on " + ports;
  }
  if (!Running()) {
    return "but main ended (exit status " + std::to_string(Exited().value_or(0)) + ") without listening";
  }
  return "but main is not listening (it is blocked before listen())";
}

HTTP Program::HTTP() {
  const auto& all = httplib::detail::listening();
  if (all.size() != 1) ctx_.Fatalf("expected main to serve HTTP on one address, %s", describe());
  return harness::HTTP(ctx_, *all[0].server);
}

HTTP Program::HTTPAt(int port) {
  for (const auto& l : httplib::detail::listening()) {
    if (l.port == port) return harness::HTTP(ctx_, *l.server);
  }
  ctx_.Fatalf("expected main to serve HTTP on port %d, %s", port, describe());
}

void Ctx::Fail(std::string message) { throw Failure{std::move(message)}; }

void Ctx::Differ(std::string message, const std::string& got, const std::string& want) {
  if (message.empty()) message = "values differ";
  Fatalf("%s: got %s, want %s", message, got, want);
}

void Ctx::Settle() { lb_settle(); }

void Ctx::Tick() { lb_tick(); }

// Go's Drain: whichever comes first, fn returning (its thread ends the harness's settle) or the
// world settling with fn still waiting.
bool Ctx::Drain(std::function<void()> fn) {
  auto done = std::make_shared<bool>(false);
  auto error = std::make_shared<std::exception_ptr>();
  lb::spawn([fn = std::move(fn), done, error] {
    try {
      fn();
    } catch (...) {
      *error = std::current_exception();
    }
    *done = true;
    lb::call("settle.release");
  });
  Settle();
  if (*error) std::rethrow_exception(*error);
  return *done;
}

Program Ctx::Main() { return Start(&__main_void); }

Program Ctx::Start(int (*main)()) {
  auto state = std::make_shared<Program::State>();
  state->thread = lb::spawn([state, main] {
    state->status = main();
    state->done = true;
  });
  Settle();
  return Program(*this, state);
}

std::string CurrentExceptionType() {
  const std::type_info* t = abi::__cxa_current_exception_type();
  if (t == nullptr) return "an exception";
  int status = 0;
  char* name = abi::__cxa_demangle(t->name(), nullptr, nullptr, &status);
  std::string out = status == 0 && name != nullptr ? name : t->name();
  std::free(name);
  return out;
}

void ReportCurrentException(const std::string& prefix) {
  try {
    throw;
  } catch (const Failure& f) {
    lb::call("check.failed", lb::Json(f.message));
  } catch (const std::exception& e) {
    lb::call("check.failed", lb::Json(prefix + " " + CurrentExceptionType() + ": " + e.what()));
  } catch (...) {
    lb::call("check.failed", lb::Json(prefix + " " + CurrentExceptionType()));
  }
}

}  // namespace harness

namespace lb {

void run_check(CheckFn fn) {
  harness::Ctx ctx;
  try {
    fn(ctx);
  } catch (...) {
    harness::ReportCurrentException("uncaught exception");
  }
}

}  // namespace lb
