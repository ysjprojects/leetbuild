// The hiredis model's compiled half (cppruntime/include/hiredis/hiredis.h), and the reply objects
// redis-plus-plus hands out (sw::redis::ReplyUPtr).
#include <hiredis/hiredis.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

struct redisContextImpl {
  std::vector<std::vector<std::string>> queued;
  std::deque<redisReply*> replies;
};

namespace sw::redis::detail {

namespace {

char* copy_text(const std::string& s) {
  char* out = static_cast<char*>(std::malloc(s.size() + 1));
  std::memcpy(out, s.data(), s.size());
  out[s.size()] = '\0';
  return out;
}

redisReply* blank(int type) {
  auto* r = static_cast<redisReply*>(std::calloc(1, sizeof(redisReply)));
  r->type = type;
  return r;
}

}  // namespace

bool status_command(const std::string& name) {
  std::string n = name;
  std::transform(n.begin(), n.end(), n.begin(), [](unsigned char c) { return std::tolower(c); });
  static const char* const kStatus[] = {"set",   "mset",  "setex",   "psetex", "flushall", "flushdb", "ltrim",
                                        "ping",  "hmset", "rename",  "select", "lset",     "watch",   "unwatch",
                                        "multi", "auth",  "discard", "type",   "quit"};
  for (const char* s : kStatus) {
    if (n == s) return true;
  }
  return false;
}

redisReply* make_reply(const lb::Json& r, bool status) {
  if (r.is_null()) return blank(REDIS_REPLY_NIL);
  if (r.is_number() || r.is_bool()) {
    redisReply* out = blank(REDIS_REPLY_INTEGER);
    out->integer = r.as_int();
    return out;
  }
  if (r.is_array()) {
    redisReply* out = blank(REDIS_REPLY_ARRAY);
    const auto& items = r.items();
    out->elements = items.size();
    out->element = static_cast<redisReply**>(std::calloc(items.size() + 1, sizeof(redisReply*)));
    for (size_t i = 0; i < items.size(); i++) out->element[i] = make_reply(items[i], false);
    return out;
  }
  redisReply* out = blank(status ? REDIS_REPLY_STATUS : REDIS_REPLY_STRING);
  out->len = r.as_string().size();
  out->str = copy_text(r.as_string());
  return out;
}

redisReply* make_error(const std::string& message) {
  redisReply* out = blank(REDIS_REPLY_ERROR);
  out->len = message.size();
  out->str = copy_text(message);
  return out;
}

redisReply* tagged_reply(const lb::Json& tagged, const std::string& name) {
  if (tagged.has("e")) return make_error(tagged["e"].as_string());
  return make_reply(tagged["r"], status_command(name));
}

lb::Json reply_json(const redisReply& r) {
  switch (r.type) {
    case REDIS_REPLY_INTEGER:
    case REDIS_REPLY_BOOL:
      return lb::Json(r.integer);
    case REDIS_REPLY_DOUBLE:
      return lb::Json(r.dval);
    case REDIS_REPLY_ARRAY:
    case REDIS_REPLY_MAP:
    case REDIS_REPLY_SET:
    case REDIS_REPLY_PUSH: {
      lb::Json out = lb::Json::array();
      for (size_t i = 0; i < r.elements; i++) out.push(reply_json(*r.element[i]));
      return out;
    }
    case REDIS_REPLY_NIL:
      return lb::Json();
    case REDIS_REPLY_ERROR:
      throw ReplyError(std::string(r.str, r.len));
    default:
      return lb::Json(std::string(r.str == nullptr ? "" : r.str, r.len));
  }
}

void ReplyDeleter::operator()(redisReply* reply) const { freeReplyObject(reply); }

}  // namespace sw::redis::detail

namespace {

redisContext* connect() {
  auto* c = static_cast<redisContext*>(std::calloc(1, sizeof(redisContext)));
  c->fd = 3;
  c->impl = new redisContextImpl();
  return c;
}

// hiredis's formatter: arguments split at (unescaped) spaces of the format; conversions fill in.
std::vector<std::string> format_command(const char* format, va_list ap) {
  std::vector<std::string> args;
  std::string current;
  bool touched = false;
  for (const char* p = format; *p != '\0'; p++) {
    if (*p == ' ') {
      if (touched) args.push_back(current);
      current.clear();
      touched = false;
      continue;
    }
    touched = true;
    if (*p != '%' || p[1] == '\0') {
      current += *p;
      continue;
    }
    p++;
    if (*p == 's') {
      const char* s = va_arg(ap, const char*);
      current += s == nullptr ? "" : s;
      continue;
    }
    if (*p == 'b') {
      const char* s = va_arg(ap, const char*);
      const size_t n = va_arg(ap, size_t);
      if (s != nullptr) current.append(s, n);
      continue;
    }
    if (*p == '%') {
      current += '%';
      continue;
    }
    // A printf conversion: flags, width, precision, length, then the verb.
    std::string spec = "%";
    while (*p != '\0' && std::strchr("#0-+ ", *p) != nullptr) spec += *p++;
    while (*p != '\0' && std::isdigit(static_cast<unsigned char>(*p))) spec += *p++;
    if (*p == '.') {
      spec += *p++;
      while (*p != '\0' && std::isdigit(static_cast<unsigned char>(*p))) spec += *p++;
    }
    std::string length;
    while (*p != '\0' && std::strchr("hlqLjzt", *p) != nullptr) length += *p++;
    if (*p == '\0') break;
    const char verb = *p;
    char buf[128];
    if (std::strchr("diouxXc", verb) != nullptr) {
      spec += length + verb;
      if (length == "ll" || length == "q" || length == "j") {
        std::snprintf(buf, sizeof buf, spec.c_str(), va_arg(ap, long long));
      } else if (length == "l" || length == "z" || length == "t") {
        std::snprintf(buf, sizeof buf, spec.c_str(), va_arg(ap, long));
      } else {
        std::snprintf(buf, sizeof buf, spec.c_str(), va_arg(ap, int));
      }
    } else if (std::strchr("eEfFgGaA", verb) != nullptr) {
      spec += (length == "L" ? "L" : "") + std::string(1, verb);
      if (length == "L") {
        std::snprintf(buf, sizeof buf, spec.c_str(), va_arg(ap, long double));
      } else {
        std::snprintf(buf, sizeof buf, spec.c_str(), va_arg(ap, double));
      }
    } else {
      buf[0] = verb;
      buf[1] = '\0';
    }
    current += buf;
  }
  if (touched) args.push_back(current);
  return args;
}

std::vector<std::string> argv_command(int argc, const char** argv, const size_t* argvlen) {
  std::vector<std::string> args;
  for (int i = 0; i < argc; i++) {
    args.emplace_back(argv[i], argvlen != nullptr ? argvlen[i] : std::strlen(argv[i]));
  }
  return args;
}

lb::Json tagged_call(const std::vector<std::string>& args) {
  return sw::redis::detail::from_bridge(lb::call("redis.execute", lb::Json(std::map<std::string, lb::Json>{
                                       {"args", sw::redis::detail::to_json(args)}, {"record", true}})));
}

void* run(redisContext* c, const std::vector<std::string>& args) {
  if (c == nullptr) return nullptr;
  if (args.empty()) {
    c->err = REDIS_ERR_OTHER;
    std::snprintf(c->errstr, sizeof c->errstr, "empty command");
    return nullptr;
  }
  return sw::redis::detail::tagged_reply(tagged_call(args), args[0]);
}

int append(redisContext* c, std::vector<std::string> args) {
  if (c == nullptr || args.empty()) return REDIS_ERR;
  c->impl->queued.push_back(std::move(args));
  return REDIS_OK;
}

}  // namespace

redisContext* redisConnect(const char*, int) { return connect(); }
redisContext* redisConnectWithTimeout(const char*, int, const struct timeval) { return connect(); }
redisContext* redisConnectNonBlock(const char*, int) { return connect(); }
redisContext* redisConnectUnix(const char*) { return connect(); }
redisContext* redisConnectWithOptions(const redisOptions*) { return connect(); }
int redisReconnect(redisContext*) { return REDIS_OK; }
int redisSetTimeout(redisContext*, const struct timeval) { return REDIS_OK; }
int redisEnableKeepAlive(redisContext*) { return REDIS_OK; }

void redisFree(redisContext* c) {
  if (c == nullptr) return;
  for (redisReply* r : c->impl->replies) freeReplyObject(r);
  delete c->impl;
  std::free(c);
}

void* redisvCommand(redisContext* c, const char* format, va_list ap) { return run(c, format_command(format, ap)); }

void* redisCommand(redisContext* c, const char* format, ...) {
  va_list ap;
  va_start(ap, format);
  void* reply = redisvCommand(c, format, ap);
  va_end(ap);
  return reply;
}

void* redisCommandArgv(redisContext* c, int argc, const char** argv, const size_t* argvlen) {
  return run(c, argv_command(argc, argv, argvlen));
}

int redisvAppendCommand(redisContext* c, const char* format, va_list ap) {
  return append(c, format_command(format, ap));
}

int redisAppendCommand(redisContext* c, const char* format, ...) {
  va_list ap;
  va_start(ap, format);
  const int status = redisvAppendCommand(c, format, ap);
  va_end(ap);
  return status;
}

int redisAppendCommandArgv(redisContext* c, int argc, const char** argv, const size_t* argvlen) {
  return append(c, argv_command(argc, argv, argvlen));
}

int redisGetReply(redisContext* c, void** reply) {
  if (c == nullptr) return REDIS_ERR;
  if (c->impl->replies.empty() && !c->impl->queued.empty()) {
    lb::Json cmds = lb::Json::array();
    for (const auto& q : c->impl->queued) cmds.push(sw::redis::detail::to_json(q));
    const lb::Json tagged = sw::redis::detail::from_bridge(lb::call("redis.pipeline", cmds));
    for (size_t i = 0; i < tagged.items().size(); i++) {
      c->impl->replies.push_back(sw::redis::detail::tagged_reply(tagged.items()[i], c->impl->queued[i][0]));
    }
    c->impl->queued.clear();
  }
  if (c->impl->replies.empty()) {
    if (reply != nullptr) *reply = nullptr;
    return REDIS_OK;
  }
  redisReply* next = c->impl->replies.front();
  c->impl->replies.pop_front();
  if (reply != nullptr) {
    *reply = next;
  } else {
    freeReplyObject(next);
  }
  return REDIS_OK;
}

void freeReplyObject(void* reply) {
  auto* r = static_cast<redisReply*>(reply);
  if (r == nullptr) return;
  for (size_t i = 0; i < r->elements; i++) freeReplyObject(r->element[i]);
  std::free(r->element);
  std::free(r->str);
  std::free(r);
}
