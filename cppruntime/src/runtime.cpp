// The runtime's core (cppruntime/include/lb/runtime.h): JSON, the bridge, green threads, waits.
#include <lb/runtime.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <leetbuild/harness.h>

// libc++abi's exceptions in flight (__cxa_eh_globals: the caught exceptions' stack and the count
// of uncaught ones, 8 bytes on wasm32).
extern "C" void* __cxa_get_globals();

namespace lb {

Json::Json(std::vector<Json> a) : kind_(Kind::Array), array_(std::make_shared<std::vector<Json>>(std::move(a))) {}

Json::Json(std::map<std::string, Json> o)
    : kind_(Kind::Object), object_(std::make_shared<std::map<std::string, Json>>(std::move(o))) {}

Json Json::array() { return Json(std::vector<Json>{}); }

Json Json::object() { return Json(std::map<std::string, Json>{}); }

const std::vector<Json>& Json::items() const {
  static const std::vector<Json> none;
  return array_ ? *array_ : none;
}

const std::map<std::string, Json>& Json::fields() const {
  static const std::map<std::string, Json> none;
  return object_ ? *object_ : none;
}

size_t Json::size() const { return array_ ? array_->size() : object_ ? object_->size() : 0; }

const Json& Json::operator[](size_t i) const {
  static const Json null;
  return array_ && i < array_->size() ? (*array_)[i] : null;
}

const Json& Json::operator[](const std::string& key) const {
  static const Json null;
  if (!object_) return null;
  auto it = object_->find(key);
  return it == object_->end() ? null : it->second;
}

bool Json::has(const std::string& key) const { return object_ && object_->count(key) > 0; }

void Json::push(Json v) {
  if (!array_) *this = array();
  array_->push_back(std::move(v));
}

void Json::set(const std::string& key, Json v) {
  if (!object_) *this = object();
  (*object_)[key] = std::move(v);
}

namespace {

void quote(const std::string& s, std::string& out) {
  out += '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  out += '"';
}

void write(const Json& v, std::string& out) {
  switch (v.kind()) {
    case Json::Kind::Null: out += "null"; return;
    case Json::Kind::Bool: out += v.as_bool() ? "true" : "false"; return;
    case Json::Kind::Number: {
      const double n = v.as_number();
      char buf[32];
      if (n == static_cast<double>(static_cast<long long>(n)) && n < 1e18 && n > -1e18) {
        std::snprintf(buf, sizeof buf, "%lld", static_cast<long long>(n));
      } else {
        std::snprintf(buf, sizeof buf, "%.17g", n);
      }
      out += buf;
      return;
    }
    case Json::Kind::String: quote(v.as_string(), out); return;
    case Json::Kind::Array: {
      out += '[';
      bool first = true;
      for (const auto& item : v.items()) {
        if (!first) out += ',';
        first = false;
        write(item, out);
      }
      out += ']';
      return;
    }
    case Json::Kind::Object: {
      out += '{';
      bool first = true;
      for (const auto& [k, item] : v.fields()) {
        if (!first) out += ',';
        first = false;
        quote(k, out);
        out += ':';
        write(item, out);
      }
      out += '}';
      return;
    }
  }
}

void skip(const std::string& t, size_t& at) {
  while (at < t.size() && (t[at] == ' ' || t[at] == '\n' || t[at] == '\r' || t[at] == '\t')) at++;
}

void utf8(unsigned code, std::string& out) {
  if (code < 0x80) {
    out += static_cast<char>(code);
  } else if (code < 0x800) {
    out += static_cast<char>(0xC0 | (code >> 6));
    out += static_cast<char>(0x80 | (code & 0x3F));
  } else if (code < 0x10000) {
    out += static_cast<char>(0xE0 | (code >> 12));
    out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (code & 0x3F));
  } else {
    out += static_cast<char>(0xF0 | (code >> 18));
    out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
    out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (code & 0x3F));
  }
}

std::string read_string(const std::string& t, size_t& at) {
  std::string out;
  at++;  // the opening quote
  while (at < t.size() && t[at] != '"') {
    const char c = t[at++];
    if (c != '\\') {
      out += c;
      continue;
    }
    const char e = t[at++];
    switch (e) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'u': {
        unsigned code = static_cast<unsigned>(std::strtoul(t.substr(at, 4).c_str(), nullptr, 16));
        at += 4;
        if (code >= 0xD800 && code < 0xDC00 && t.compare(at, 2, "\\u") == 0) {
          const unsigned low = static_cast<unsigned>(std::strtoul(t.substr(at + 2, 4).c_str(), nullptr, 16));
          at += 6;
          code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        }
        utf8(code, out);
        break;
      }
      default: out += e;
    }
  }
  at++;  // the closing quote
  return out;
}

Json read(const std::string& t, size_t& at) {
  skip(t, at);
  if (at >= t.size()) return Json();
  const char c = t[at];
  if (c == '{') {
    Json o = Json::object();
    at++;
    skip(t, at);
    if (at < t.size() && t[at] == '}') {
      at++;
      return o;
    }
    while (at < t.size()) {
      skip(t, at);
      std::string key = read_string(t, at);
      skip(t, at);
      at++;  // ':'
      o.set(key, read(t, at));
      skip(t, at);
      if (at >= t.size() || t[at++] == '}') break;
    }
    return o;
  }
  if (c == '[') {
    Json a = Json::array();
    at++;
    skip(t, at);
    if (at < t.size() && t[at] == ']') {
      at++;
      return a;
    }
    while (at < t.size()) {
      a.push(read(t, at));
      skip(t, at);
      if (at >= t.size() || t[at++] == ']') break;
    }
    return a;
  }
  if (c == '"') return Json(read_string(t, at));
  if (t.compare(at, 4, "true") == 0) {
    at += 4;
    return Json(true);
  }
  if (t.compare(at, 5, "false") == 0) {
    at += 5;
    return Json(false);
  }
  if (t.compare(at, 4, "null") == 0) {
    at += 4;
    return Json();
  }
  size_t end = at;
  while (end < t.size() && std::strchr("+-0123456789.eE", t[end]) != nullptr) end++;
  const double n = std::strtod(t.substr(at, end - at).c_str(), nullptr);
  at = end;
  return Json(n);
}

std::string take_reply(int length) {
  std::string out(static_cast<size_t>(length), '\0');
  if (length > 0) lb_reply(out.data());
  return out;
}

int new_token() {
  static int next = 0;
  return ++next;
}

std::vector<std::function<void()>>& invocables() {
  static std::vector<std::function<void()>> all;
  return all;
}

std::vector<std::function<void(const std::string&)>>& receivers() {
  static std::vector<std::function<void(const std::string&)>> all;
  return all;
}

}  // namespace

std::string Json::dump() const {
  std::string out;
  write(*this, out);
  return out;
}

Json Json::parse(const std::string& text) {
  size_t at = 0;
  return read(text, at);
}

Json call(const std::string& op, const Json& request) {
  const std::string body = request.dump();
  return Json::parse(
      take_reply(lb_call(op.data(), static_cast<int>(op.size()), body.data(), static_cast<int>(body.size()))));
}

Json call_async(const std::string& op, const Json& request) {
  const std::string body = request.dump();
  return Json::parse(
      take_reply(lb_call_async(op.data(), static_cast<int>(op.size()), body.data(), static_cast<int>(body.size()))));
}

int spawn(std::function<void()> fn) { return lb_spawn(new Task{std::move(fn)}); }

bool WaitQueue::wait(double ms) {
  const int token = new_token();
  waiters_.push_back(token);
  bool woken = true;
  if (ms < 0) {
    lb_park(token);
  } else {
    woken = lb_park_for(token, ms) != 0;
  }
  for (auto it = waiters_.begin(); it != waiters_.end(); ++it) {
    if (*it == token) {
      waiters_.erase(it);
      break;
    }
  }
  return woken;
}

bool WaitQueue::notify_one() {
  while (!waiters_.empty()) {
    const int token = waiters_.front();
    waiters_.erase(waiters_.begin());
    if (lb_unpark(token) != 0) return true;
  }
  return false;
}

void WaitQueue::notify_all() {
  std::vector<int> all;
  all.swap(waiters_);
  for (int token : all) lb_unpark(token);
}

int invocable(std::function<void()> fn) {
  invocables().push_back(std::move(fn));
  return static_cast<int>(invocables().size()) - 1;
}

int receiver(std::function<void(const std::string&)> fn) {
  receivers().push_back(std::move(fn));
  return static_cast<int>(receivers().size()) - 1;
}

void thread_main(void* task) {
  std::unique_ptr<Task> owned(static_cast<Task*>(task));
  try {
    owned->run();
  } catch (const harness::Failure& f) {
    call("check.failed", Json(f.message));
  } catch (const std::exception& e) {
    call("thread.uncaught", Json(harness::CurrentExceptionType() + ": " + e.what()));
  } catch (...) {
    call("thread.uncaught", Json(harness::CurrentExceptionType()));
  }
}

void invoke(int handle) {
  try {
    invocables()[static_cast<size_t>(handle)]();
  } catch (...) {
    harness::ReportCurrentException("uncaught exception in a callback:");
  }
}

void deliver(int handle, char* data, int size) {
  std::string payload(data, static_cast<size_t>(size));
  std::free(data);
  receivers()[static_cast<size_t>(handle)](payload);
}

void* eh_globals() { return __cxa_get_globals(); }

}  // namespace lb
