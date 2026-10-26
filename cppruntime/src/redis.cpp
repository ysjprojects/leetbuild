// The redis-plus-plus model's compiled half (cppruntime/include/sw/redis++/redis++.h).
#include <sw/redis++/redis++.h>

#include <cstdio>
#include <limits>

namespace sw::redis {

namespace detail {

std::string number(double v) {
  if (v == std::numeric_limits<double>::infinity()) return "+inf";
  if (v == -std::numeric_limits<double>::infinity()) return "-inf";
  char buf[64];
  std::snprintf(buf, sizeof buf, "%.17g", v);
  return buf;
}

std::string bound(double v, bool open) {
  if (v == std::numeric_limits<double>::infinity()) return "+inf";
  if (v == -std::numeric_limits<double>::infinity()) return "-inf";
  return (open ? "(" : "") + number(v);
}

std::string bound(const std::string& v, bool open) { return (open ? "(" : "[") + v; }

std::string to_bridge(std::string_view bytes) {
  std::string out;
  out.reserve(bytes.size());
  for (const char ch : bytes) {
    const auto b = static_cast<unsigned char>(ch);
    if (b < 0x80) {
      out += ch;
    } else {
      out += static_cast<char>(0xC0 | (b >> 6));
      out += static_cast<char>(0x80 | (b & 0x3F));
    }
  }
  return out;
}

std::string from_bridge(std::string_view text) {
  std::string out;
  out.reserve(text.size());
  for (size_t i = 0; i < text.size(); i++) {
    const auto b = static_cast<unsigned char>(text[i]);
    // U+0080..U+00FF is C2/C3 and one continuation byte: that byte value. Anything else (ASCII, or
    // a code point above U+00FF the JavaScript side made itself) is kept as it is.
    if ((b == 0xC2 || b == 0xC3) && i + 1 < text.size() && (static_cast<unsigned char>(text[i + 1]) & 0xC0) == 0x80) {
      out += static_cast<char>(((b & 0x03) << 6) | (static_cast<unsigned char>(text[i + 1]) & 0x3F));
      i++;
    } else {
      out += text[i];
    }
  }
  return out;
}

lb::Json from_bridge(const lb::Json& v) {
  if (v.is_string()) return lb::Json(from_bridge(std::string_view(v.as_string())));
  if (v.is_array()) {
    lb::Json out = lb::Json::array();
    for (const auto& item : v.items()) out.push(from_bridge(item));
    return out;
  }
  if (v.is_object()) {
    lb::Json out = lb::Json::object();
    for (const auto& [k, item] : v.fields()) out.set(k, from_bridge(item));
    return out;
  }
  return v;
}

lb::Json to_json(const std::vector<std::string>& args) {
  lb::Json list = lb::Json::array();
  for (const auto& a : args) list.push(lb::Json(to_bridge(a)));
  return list;
}

lb::Json execute(const std::vector<std::string>& args) {
  const lb::Json reply = from_bridge(
      lb::call("redis.execute", lb::Json(std::map<std::string, lb::Json>{{"args", to_json(args)}, {"record", true}})));
  if (reply.has("e")) throw ReplyError(reply["e"].as_string());
  return reply["r"];
}

std::vector<std::string> script_cmd(const char* name, std::string_view script, const std::vector<std::string>& keys,
                                    const std::vector<std::string>& args) {
  std::vector<std::string> out;
  out.reserve(3 + keys.size() + args.size());
  out.emplace_back(name);
  out.emplace_back(script);
  out.push_back(std::to_string(keys.size()));
  out.insert(out.end(), keys.begin(), keys.end());
  out.insert(out.end(), args.begin(), args.end());
  return out;
}

std::string update_flag(UpdateType type) {
  switch (type) {
    case UpdateType::EXIST: return "XX";
    case UpdateType::NOT_EXIST: return "NX";
    case UpdateType::GREATER: return "GT";
    case UpdateType::LESS: return "LT";
    default: return "";
  }
}

std::string unit(GeoUnit u) {
  switch (u) {
    case GeoUnit::KM: return "km";
    case GeoUnit::MI: return "mi";
    case GeoUnit::FT: return "ft";
    default: return "m";
  }
}

QueuedReplies send_queued(const char* op, std::vector<std::vector<std::string>>& queued) {
  lb::Json cmds = lb::Json::array();
  for (const auto& c : queued) cmds.push(to_json(c));
  queued.clear();
  const lb::Json tagged = from_bridge(lb::call(op, cmds));
  std::vector<lb::Json> replies;
  std::vector<std::string> errors;
  for (const auto& t : tagged.items()) {
    replies.push_back(t["r"]);
    errors.push_back(t.has("e") ? t["e"].as_string() : "");
  }
  return QueuedReplies(std::move(replies), std::move(errors));
}

namespace {

std::string fingerprint(const std::string& key) {
  return lb::call("redis.fingerprint", lb::Json(to_bridge(key))).as_string();
}

}  // namespace

void watch(WatchState& state, const std::vector<std::string>& keys) {
  for (const auto& k : keys) state.keys.emplace_back(k, fingerprint(k));
}

bool watch_intact(WatchState& state) {
  bool intact = true;
  for (const auto& [k, seen] : state.keys) {
    if (fingerprint(k) != seen) intact = false;
  }
  state.keys.clear();
  return intact;
}

}  // namespace detail

Redis::Redis(const std::string& uri) : watch_(std::make_shared<detail::WatchState>()) {
  // tcp://[[user:]password@]host[:port][/db]
  std::string rest = uri;
  const size_t scheme = rest.find("://");
  if (scheme != std::string::npos) rest = rest.substr(scheme + 3);
  const size_t at = rest.rfind('@');
  if (at != std::string::npos) rest = rest.substr(at + 1);
  const size_t slash = rest.find('/');
  if (slash != std::string::npos) rest = rest.substr(0, slash);
  const size_t colon = rest.rfind(':');
  options_.host = rest.substr(0, colon);
  if (colon != std::string::npos) options_.port = std::atoi(rest.c_str() + colon + 1);
}

void QueuedReplies::check(std::size_t idx) const {
  if (idx >= replies_.size()) throw Error("no reply " + std::to_string(idx));
  if (!errors_[idx].empty()) throw ReplyError(errors_[idx]);
}

redisReply& QueuedReplies::get(std::size_t idx) {
  if (idx >= replies_.size()) throw Error("no reply " + std::to_string(idx));
  if (raw_.empty()) raw_.resize(replies_.size());
  if (!raw_[idx]) {
    raw_[idx] = ReplyUPtr(errors_[idx].empty() ? detail::make_reply(replies_[idx], false) : nullptr);
    if (!raw_[idx]) {
      check(idx);
    }
  }
  return *raw_[idx];
}

QueuedReplies Transaction::exec() {
  if (!watch_->keys.empty() && !detail::watch_intact(*watch_)) {
    queued_.clear();
    throw WatchError();
  }
  return send("redis.transaction");
}

void Subscriber::consume() {
  while (state_->inbox.empty()) {
    if (state_->timeout_ms > 0) {
      if (!state_->arrived.wait(state_->timeout_ms) && state_->inbox.empty()) throw TimeoutError("Failed to get reply: Resource temporarily unavailable");
    } else {
      state_->arrived.wait();
    }
  }
  Event e = state_->inbox.front();
  state_->inbox.erase(state_->inbox.begin());
  switch (e.type) {
    case MsgType::MESSAGE:
      if (state_->on_message) state_->on_message(e.channel, e.message);
      break;
    case MsgType::PMESSAGE:
      if (state_->on_pmessage) state_->on_pmessage(e.pattern, e.channel, e.message);
      break;
    default:
      if (state_->on_meta) state_->on_meta(e.type, e.channel, e.num);
      break;
  }
}

void Subscriber::listen(const std::string& name, bool pattern) {
  for (const auto& s : state_->subscribed) {
    if (s.first == name && s.second == pattern) return;
  }
  state_->subscribed.emplace_back(name, pattern);
  std::weak_ptr<State> weak = state_;
  const int handle = lb::receiver([weak, name, pattern](const std::string& payload) {
    auto state = weak.lock();
    if (!state) return;
    bool live = false;
    for (const auto& s : state->subscribed) live = live || (s.first == name && s.second == pattern);
    if (!live) return;
    const lb::Json m = detail::from_bridge(lb::Json::parse(payload));
    Event e{m[0].is_null() ? MsgType::MESSAGE : MsgType::PMESSAGE, m[0].is_null() ? "" : m[0].as_string(),
            m[1].as_string(), m[2].as_string()};
    state->inbox.push_back(std::move(e));
    state->arrived.notify_all();
  });
  state_->handles.push_back(handle);
  lb::call("redis.subscribe", lb::Json(std::map<std::string, lb::Json>{
                                  {"name", detail::to_bridge(name)}, {"pattern", pattern}, {"handle", handle}}));
  state_->inbox.push_back(Event{pattern ? MsgType::PSUBSCRIBE : MsgType::SUBSCRIBE, "", name, "",
                                static_cast<long long>(state_->subscribed.size())});
  state_->arrived.notify_all();
}

void Subscriber::forget(const std::string& name, bool pattern, bool all) {
  auto& subs = state_->subscribed;
  for (size_t i = 0; i < subs.size();) {
    if (subs[i].second == pattern && (all || subs[i].first == name)) {
      const std::string gone = subs[i].first;
      subs.erase(subs.begin() + static_cast<std::ptrdiff_t>(i));
      const int handle = state_->handles[i];
      state_->handles.erase(state_->handles.begin() + static_cast<std::ptrdiff_t>(i));
      lb::call("redis.unsubscribe", lb::Json(std::map<std::string, lb::Json>{{"handle", handle}}));
      state_->inbox.push_back(Event{pattern ? MsgType::PUNSUBSCRIBE : MsgType::UNSUBSCRIBE, "", gone, "",
                                    static_cast<long long>(subs.size())});
    } else {
      i++;
    }
  }
  state_->arrived.notify_all();
}

Subscriber::State::~State() {
  for (const int handle : handles) lb::call("redis.unsubscribe", lb::Json(std::map<std::string, lb::Json>{{"handle", handle}}));
}

void Subscriber::unsubscribe() { forget("", false, true); }
void Subscriber::unsubscribe(const StringView& channel) { forget(std::string(channel), false, false); }
void Subscriber::punsubscribe() { forget("", true, true); }
void Subscriber::punsubscribe(const StringView& pattern) { forget(std::string(pattern), true, false); }

}  // namespace sw::redis
