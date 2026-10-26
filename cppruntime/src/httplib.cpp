// The cpp-httplib model's compiled half (cppruntime/include/httplib.h): routing, URLs, listening,
// the in-process network and its Client.
#include <httplib.h>
#include <openssl/ssl.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>

namespace httplib {

bool detail::ci::operator()(const std::string& a, const std::string& b) const {
  return std::lexicographical_compare(a.begin(), a.end(), b.begin(), b.end(), [](unsigned char x, unsigned char y) {
    return std::tolower(x) < std::tolower(y);
  });
}

const char* status_message(int status) {
  switch (status) {
    case 100: return "Continue";
    case 101: return "Switching Protocol";
    case 200: return "OK";
    case 201: return "Created";
    case 202: return "Accepted";
    case 203: return "Non-Authoritative Information";
    case 204: return "No Content";
    case 205: return "Reset Content";
    case 206: return "Partial Content";
    case 300: return "Multiple Choices";
    case 301: return "Moved Permanently";
    case 302: return "Found";
    case 303: return "See Other";
    case 304: return "Not Modified";
    case 307: return "Temporary Redirect";
    case 308: return "Permanent Redirect";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 402: return "Payment Required";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 406: return "Not Acceptable";
    case 408: return "Request Timeout";
    case 409: return "Conflict";
    case 410: return "Gone";
    case 411: return "Length Required";
    case 412: return "Precondition Failed";
    case 413: return "Payload Too Large";
    case 414: return "URI Too Long";
    case 415: return "Unsupported Media Type";
    case 416: return "Range Not Satisfiable";
    case 417: return "Expectation Failed";
    case 418: return "I'm a teapot";
    case 422: return "Unprocessable Content";
    case 423: return "Locked";
    case 424: return "Failed Dependency";
    case 425: return "Too Early";
    case 426: return "Upgrade Required";
    case 428: return "Precondition Required";
    case 429: return "Too Many Requests";
    case 431: return "Request Header Fields Too Large";
    case 451: return "Unavailable For Legal Reasons";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    case 504: return "Gateway Timeout";
    case 505: return "HTTP Version Not Supported";
    default: return "Internal Server Error";
  }
}

std::string get_header_value(const Headers& headers, const std::string& key, const char* def, size_t id) {
  auto range = headers.equal_range(key);
  auto it = range.first;
  for (size_t i = 0; i < id && it != range.second; i++) ++it;
  return it != range.second ? it->second : std::string(def == nullptr ? "" : def);
}

namespace {

uint64_t to_u64(const std::string& s, uint64_t def) {
  if (s.empty()) return def;
  char* end = nullptr;
  const unsigned long long v = std::strtoull(s.c_str(), &end, 10);
  return end != nullptr && *end == '\0' ? v : def;
}

}  // namespace

uint64_t Request::get_header_value_u64(const std::string& key, uint64_t def, size_t id) const {
  return to_u64(get_header_value(key, "", id), def);
}

uint64_t Response::get_header_value_u64(const std::string& key, uint64_t def, size_t id) const {
  return to_u64(get_header_value(key, "", id), def);
}

std::string Request::get_param_value(const std::string& key, size_t id) const {
  auto range = params.equal_range(key);
  auto it = range.first;
  for (size_t i = 0; i < id && it != range.second; i++) ++it;
  return it != range.second ? it->second : std::string();
}

bool Request::is_multipart_form_data() const {
  return get_header_value("Content-Type").rfind("multipart/form-data", 0) == 0;
}

MultipartFormData Request::get_file_value(const std::string& key) const {
  auto it = files.find(key);
  return it != files.end() ? it->second : MultipartFormData();
}

// ---- DataSink -------------------------------------------------------------------------------------

DataSink::DataSink() : os(nullptr), buffer_(*this) { os.rdbuf(&buffer_); }

std::streamsize DataSink::Buffer::xsputn(const char* s, std::streamsize n) {
  if (!sink_.write || !sink_.write(s, static_cast<size_t>(n))) return 0;
  return n;
}

DataSink::Buffer::int_type DataSink::Buffer::overflow(int_type c) {
  if (c == traits_type::eof()) return traits_type::not_eof(c);
  const char ch = traits_type::to_char_type(c);
  return xsputn(&ch, 1) == 1 ? c : traits_type::eof();
}

// ---- Response -------------------------------------------------------------------------------------

void Response::set_header(const std::string& key, const std::string& val) {
  if (key.find_first_of("\r\n") != std::string::npos || val.find_first_of("\r\n") != std::string::npos) return;
  headers.emplace(key, val);
}

void Response::set_redirect(const std::string& url, int stat) {
  set_header("Location", url);
  status = (stat >= 300 && stat < 400) ? stat : Found_302;
}

namespace {

void replace_content_type(Headers& headers, const std::string& content_type) {
  headers.erase("Content-Type");
  if (!content_type.empty()) headers.emplace("Content-Type", content_type);
}

}  // namespace

void Response::set_content(const char* s, size_t n, const std::string& content_type) {
  body.assign(s, n);
  replace_content_type(headers, content_type);
}

void Response::set_content(const std::string& s, const std::string& content_type) {
  set_content(s.data(), s.size(), content_type);
}

void Response::set_content(std::string&& s, const std::string& content_type) {
  body = std::move(s);
  replace_content_type(headers, content_type);
}

void Response::set_content_provider(size_t length, const std::string& content_type, ContentProvider provider,
                                    ContentProviderResourceReleaser releaser) {
  replace_content_type(headers, content_type);
  content_length_ = length;
  content_provider_ = std::move(provider);
  chunked_provider_ = nullptr;
  content_provider_resource_releaser_ = std::move(releaser);
  is_chunked_content_provider_ = false;
}

void Response::set_content_provider(const std::string& content_type, ContentProviderWithoutLength provider,
                                    ContentProviderResourceReleaser releaser) {
  replace_content_type(headers, content_type);
  content_length_ = 0;
  content_provider_ = nullptr;
  chunked_provider_ = std::move(provider);
  content_provider_resource_releaser_ = std::move(releaser);
  is_chunked_content_provider_ = false;
}

void Response::set_chunked_content_provider(const std::string& content_type, ContentProviderWithoutLength provider,
                                            ContentProviderResourceReleaser releaser) {
  set_content_provider(content_type, std::move(provider), std::move(releaser));
  is_chunked_content_provider_ = true;
}

void Response::set_file_content(const std::string& path, const std::string& content_type) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    status = NotFound_404;
    return;
  }
  std::ostringstream all;
  all << in.rdbuf();
  set_content(all.str(), content_type.empty() ? "application/octet-stream" : content_type);
}

namespace {

// Run a streamed body's provider as the server writes the response: until done, a failed provider,
// or the client hanging up (req.client_reads).
void stream_body(const Request& req, Response& res) {
  if (!res.content_provider_ && !res.chunked_provider_) return;
  const bool head = req.method == "HEAD";
  size_t offset = 0;
  bool open = true;
  bool ok = true;
  const size_t limit = req.client_reads;
  DataSink sink;
  sink.is_writable = [&] { return open && offset < limit; };
  sink.write = [&](const char* d, size_t n) {
    if (!open || offset >= limit) return false;
    const size_t take = std::min(n, limit - offset);
    if (!head) res.body.append(d, take);
    offset += take;
    return take == n;
  };
  sink.done = [&] { open = false; };
  sink.done_with_trailer = [&](const Headers& trailer) {
    for (const auto& [k, v] : trailer) res.headers.emplace(k, v);
    open = false;
  };
  if (res.content_provider_) {
    const size_t length = res.content_length_;
    while (open && offset < length && offset < limit) {
      const size_t before = offset;
      if (!res.content_provider_(offset, length - offset, sink)) {
        ok = false;
        break;
      }
      if (offset == before) break;
    }
  } else {
    for (int rounds = 0; open && offset < limit && rounds < 100000; rounds++) {
      if (!res.chunked_provider_(offset, sink)) {
        ok = false;
        break;
      }
    }
  }
  if (res.content_provider_resource_releaser_) res.content_provider_resource_releaser_(ok && offset < limit);
  res.content_provider_ = nullptr;
  res.chunked_provider_ = nullptr;
  res.content_provider_resource_releaser_ = nullptr;
}

}  // namespace

// ---- URLs and the in-process network ---------------------------------------------------------------

namespace detail {

std::vector<Listening>& listening() {
  static std::vector<Listening> all;
  return all;
}

std::vector<Listening>& endpoints() {
  static std::vector<Listening> all;
  return all;
}

namespace {

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
  return s;
}

bool wildcard(const std::string& host) { return host.empty() || host == "0.0.0.0" || host == "::" || host == "*"; }

bool local(const std::string& host) { return host == "localhost" || host == "127.0.0.1" || host == "::1"; }

}  // namespace

Server* find_endpoint(const std::string& host, int port) {
  const std::string want = lower(host);
  Server* any = nullptr;
  for (const auto& e : endpoints()) {
    if (e.port != port) continue;
    const std::string have = lower(e.host);
    if (have == want || (local(have) && local(want))) return e.server;
    if (any == nullptr && wildcard(have)) any = e.server;
  }
  return any;
}

std::string decode_url(const std::string& s, bool plus_as_space) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '%' && i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1])) &&
        std::isxdigit(static_cast<unsigned char>(s[i + 2]))) {
      out += static_cast<char>(std::strtol(s.substr(i + 1, 2).c_str(), nullptr, 16));
      i += 2;
    } else if (plus_as_space && s[i] == '+') {
      out += ' ';
    } else {
      out += s[i];
    }
  }
  return out;
}

std::string encode_url(const std::string& s) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  for (unsigned char c : s) {
    if (std::isalnum(c) || std::strchr("-_.~/?=&%:+,;@!$'()*[]#", c) != nullptr) {
      out += static_cast<char>(c);
    } else {
      out += '%';
      out += hex[c >> 4];
      out += hex[c & 15];
    }
  }
  return out;
}

void parse_query_text(const std::string& query, Params& params) {
  size_t at = 0;
  while (at <= query.size()) {
    size_t end = query.find('&', at);
    if (end == std::string::npos) end = query.size();
    const std::string pair = query.substr(at, end - at);
    if (!pair.empty()) {
      const size_t eq = pair.find('=');
      params.emplace(decode_url(pair.substr(0, eq), true), eq == std::string::npos ? "" : decode_url(pair.substr(eq + 1), true));
    }
    at = end + 1;
  }
}

std::string params_to_query_str(const Params& params) {
  static const char* hex = "0123456789ABCDEF";
  auto component = [](const std::string& s) {
    std::string out;
    for (unsigned char c : s) {
      if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
        out += static_cast<char>(c);
      } else {
        out += '%';
        out += hex[c >> 4];
        out += hex[c & 15];
      }
    }
    return out;
  };
  std::string out;
  for (const auto& [k, v] : params) {
    if (!out.empty()) out += '&';
    out += component(k) + "=" + component(v);
  }
  return out;
}

std::string base64_encode(const std::string& in) {
  static const char* table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  size_t i = 0;
  for (; i + 2 < in.size(); i += 3) {
    const uint32_t v = (uint32_t(uint8_t(in[i])) << 16) | (uint32_t(uint8_t(in[i + 1])) << 8) | uint8_t(in[i + 2]);
    out += table[(v >> 18) & 63];
    out += table[(v >> 12) & 63];
    out += table[(v >> 6) & 63];
    out += table[v & 63];
  }
  if (i < in.size()) {
    uint32_t v = uint32_t(uint8_t(in[i])) << 16;
    if (i + 1 < in.size()) v |= uint32_t(uint8_t(in[i + 1])) << 8;
    out += table[(v >> 18) & 63];
    out += table[(v >> 12) & 63];
    out += i + 1 < in.size() ? table[(v >> 6) & 63] : '=';
    out += '=';
  }
  return out;
}

struct Matcher::Impl {
  bool params = false;
  std::vector<std::string> segments;
  std::regex regex;
};

namespace {

std::vector<std::string> split_segments(const std::string& path) {
  std::vector<std::string> parts;
  size_t at = 0;
  while (at < path.size()) {
    size_t slash = path.find('/', at + 1);
    if (slash == std::string::npos) slash = path.size();
    parts.push_back(path.substr(at, slash - at));
    at = slash;
  }
  return parts;
}

}  // namespace

Matcher::Matcher(const std::string& pattern) : impl_(std::make_shared<Impl>()) {
  if (pattern.find("/:") != std::string::npos) {
    impl_->params = true;
    impl_->segments = split_segments(pattern);
  } else {
    impl_->regex = std::regex(pattern);
  }
}

bool Matcher::match(Request& req) const {
  if (!impl_->params) return std::regex_match(req.path, req.matches, impl_->regex);
  const std::vector<std::string> parts = split_segments(req.path);
  if (parts.size() != impl_->segments.size()) return false;
  std::unordered_map<std::string, std::string> found;
  for (size_t i = 0; i < parts.size(); i++) {
    const std::string& seg = impl_->segments[i];
    if (seg.size() > 2 && seg[1] == ':') {
      if (parts[i].size() < 2) return false;
      found[seg.substr(2)] = parts[i].substr(1);
    } else if (seg != parts[i]) {
      return false;
    }
  }
  req.path_params = std::move(found);
  return true;
}

}  // namespace detail

// ---- Server ---------------------------------------------------------------------------------------

Server::~Server() { forget(); }

Server& Server::set_error_handler(Handler handler) {
  error_ = [handler = std::move(handler)](const Request& req, Response& res) {
    handler(req, res);
    return HandlerResponse::Handled;
  };
  return *this;
}

bool Server::bind_to_port(const std::string& host, int port, int) {
  host_ = host;
  port_ = port;
  bound_ = true;
  return true;
}

int Server::bind_to_any_port(const std::string& host, int socket_flags) {
  bind_to_port(host, 8080, socket_flags);
  return port_;
}

bool Server::listen_after_bind() {
  if (!bound_) return false;
  running_ = true;
  stopped_ = false;
  detail::listening().push_back({this, host_, port_});
  detail::endpoints().push_back({this, host_, port_});
  ready_.notify_all();
  while (!stopped_ || in_flight_ > 0) stop_wait_.wait();
  forget();
  running_ = false;
  return true;
}

bool Server::listen(const std::string& host, int port, int socket_flags) {
  return bind_to_port(host, port, socket_flags) && listen_after_bind();
}

void Server::wait_until_ready() const {
  while (!running_ && !stopped_) ready_.wait();
}

void Server::stop() {
  stopped_ = true;
  forget();
  stop_wait_.notify_all();
  ready_.notify_all();
}

void Server::serve_in_process(const std::string& host, int port) {
  host_ = host;
  port_ = port;
  bound_ = true;
  running_ = true;
  stopped_ = false;
  detail::endpoints().push_back({this, host, port});
}

Response Server::handle(Request req) {
  in_flight_++;
  Response res;
  try {
    res = process(std::move(req));
  } catch (...) {
    finish();
    throw;
  }
  finish();
  return res;
}

std::function<Response()> Server::hold(Request req) {
  in_flight_++;
  auto done = std::make_shared<bool>(false);
  return [this, req = std::move(req), done]() mutable {
    if (*done) return Response();
    *done = true;
    Response res;
    try {
      res = process(std::move(req));
    } catch (...) {
      finish();
      throw;
    }
    finish();
    return res;
  };
}

void Server::finish() {
  in_flight_--;
  stop_wait_.notify_all();
}

Response Server::process(Request req) {
  Response res;
  for (const auto& [k, v] : default_headers_) res.headers.emplace(k, v);
  if (req.target.empty()) req.target = req.path;
  const size_t q = req.path.find('?');
  if (q != std::string::npos) {
    detail::parse_query_text(req.path.substr(q + 1), req.params);
    req.path = req.path.substr(0, q);
  }
  req.path = detail::decode_url(req.path, false);
  if (port_ != 0) req.local_port = port_;
  if (payload_max_ > 0 && req.body.size() > payload_max_) {
    res.status = PayloadTooLarge_413;
  } else {
    try {
      const bool routed = routing(req, res);
      if (res.status == -1) res.status = routed ? OK_200 : NotFound_404;
    } catch (...) {
      const auto error = std::current_exception();
      res.status = InternalServerError_500;
      if (exception_) {
        exception_(req, res, error);
      } else {
        try {
          std::rethrow_exception(error);
        } catch (const std::exception& e) {
          res.set_header("EXCEPTION_WHAT", e.what());
        } catch (...) {
          res.set_header("EXCEPTION_WHAT", "UNKNOWN");
        }
      }
    }
  }
  if (res.status == -1) res.status = OK_200;
  if (res.status >= 400 && error_ && res.body.empty() && !res.content_provider_ && !res.chunked_provider_) {
    error_(req, res);
  }
  if (post_routing_) post_routing_(req, res);
  if (res.reason.empty()) res.reason = status_message(res.status);
  const bool chunked = res.is_chunked_content_provider_;
  stream_body(req, res);
  // What real cpp-httplib writes on the wire: the body's length, or chunked transfer for a chunked provider.
  if (chunked) {
    if (!res.has_header("Transfer-Encoding")) res.set_header("Transfer-Encoding", "chunked");
  } else if (!res.has_header("Content-Length")) {
    res.set_header("Content-Length", std::to_string(res.body.size()));
  }
  if (req.method == "HEAD") res.body.clear();
  if (logger_) logger_(req, res);
  return res;
}

Server& Server::route(const char* method, const std::string& pattern, Handler handler) {
  routes_.push_back({method, detail::Matcher(pattern), std::move(handler)});
  return *this;
}

bool Server::routing(Request& req, Response& res) {
  if (pre_routing_ && pre_routing_(req, res) == HandlerResponse::Handled) return true;
  const std::string method = req.method == "HEAD" ? "GET" : req.method;
  for (const Route& r : routes_) {
    if (r.method != method) continue;
    if (r.matcher.match(req)) {
      r.handler(req, res);
      return true;
    }
  }
  return false;
}

void Server::forget() {
  for (auto* all : {&detail::listening(), &detail::endpoints()}) {
    all->erase(std::remove_if(all->begin(), all->end(), [this](const detail::Listening& l) { return l.server == this; }),
               all->end());
  }
}

SSLServer::SSLServer(const char* cert_path, const char* private_key_path, const char*, const char*, const char*)
    : ctx_(SSL_CTX_new(TLS_server_method())),
      cert_path_(cert_path == nullptr ? "" : cert_path),
      key_path_(private_key_path == nullptr ? "" : private_key_path) {
  SSL_CTX_use_certificate_chain_file(ctx_, cert_path_.c_str());
  SSL_CTX_use_PrivateKey_file(ctx_, key_path_.c_str(), SSL_FILETYPE_PEM);
}

SSLServer::~SSLServer() { SSL_CTX_free(ctx_); }

// ---- Client ---------------------------------------------------------------------------------------

std::string to_string(Error error) {
  switch (error) {
    case Error::Success: return "Success (no error)";
    case Error::Connection: return "Could not establish connection";
    case Error::BindIPAddress: return "Failed to bind IP address";
    case Error::Read: return "Failed to read connection";
    case Error::Write: return "Failed to write connection";
    case Error::ExceedRedirectCount: return "Maximum redirect count exceeded";
    case Error::Canceled: return "Connection handling canceled";
    case Error::SSLConnection: return "SSL connection failed";
    case Error::SSLLoadingCerts: return "SSL certificate loading failed";
    case Error::SSLServerVerification: return "SSL server verification failed";
    case Error::SSLServerHostnameVerification: return "SSL server hostname verification failed";
    case Error::UnsupportedMultipartBoundaryChars: return "Unsupported HTTP multipart boundary characters";
    case Error::Compression: return "Compression failed";
    case Error::ConnectionTimeout: return "Connection timed out";
    case Error::ProxyConnection: return "Proxy connection failed";
    default: return "Unknown";
  }
}

std::ostream& operator<<(std::ostream& os, const Error& obj) {
  os << to_string(obj) << " (" << static_cast<int>(obj) << ')';
  return os;
}

Client::Client(const std::string& scheme_host_port) {
  std::string rest = scheme_host_port;
  const size_t scheme = rest.find("://");
  if (scheme != std::string::npos) {
    scheme_ = detail::lower(rest.substr(0, scheme));
    rest = rest.substr(scheme + 3);
    if (scheme_ != "http" && scheme_ != "https") valid_ = false;
  }
  port_ = scheme_ == "https" ? 443 : 80;
  const size_t slash = rest.find_first_of("/?#");
  if (slash != std::string::npos) rest = rest.substr(0, slash);
  if (!rest.empty() && rest[0] == '[') {
    const size_t close = rest.find(']');
    host_ = rest.substr(1, close == std::string::npos ? std::string::npos : close - 1);
    if (close != std::string::npos && close + 1 < rest.size() && rest[close + 1] == ':') {
      port_ = std::atoi(rest.c_str() + close + 2);
    }
  } else {
    const size_t colon = rest.rfind(':');
    host_ = rest.substr(0, colon);
    if (colon != std::string::npos) port_ = std::atoi(rest.c_str() + colon + 1);
  }
  if (host_.empty()) valid_ = false;
}

Client::Client(const std::string& scheme_host_port, const std::string&, const std::string&)
    : Client(scheme_host_port) {}

Client::Client(const std::string& host, int port) : host_(host), port_(port) {}

Client::Client(const std::string& host, int port, const std::string&, const std::string&) : Client(host, port) {}

void Client::set_basic_auth(const std::string& username, const std::string& password) {
  default_headers_.erase("Authorization");
  default_headers_.emplace("Authorization", "Basic " + detail::base64_encode(username + ":" + password));
}

void Client::set_bearer_token_auth(const std::string& token) {
  default_headers_.erase("Authorization");
  default_headers_.emplace("Authorization", "Bearer " + token);
}

Result Client::Get(const std::string& path, const Headers& headers) {
  Request req;
  req.method = "GET";
  req.path = path;
  req.headers = headers;
  return send(req);
}

Result Client::Get(const std::string& path, const Params& params, const Headers& headers) {
  if (params.empty()) return Get(path, headers);
  return Get(path + (path.find('?') == std::string::npos ? "?" : "&") + detail::params_to_query_str(params), headers);
}

Result Client::Head(const std::string& path, const Headers& headers) {
  Request req;
  req.method = "HEAD";
  req.path = path;
  req.headers = headers;
  return send(req);
}

Result Client::Options(const std::string& path, const Headers& headers) {
  Request req;
  req.method = "OPTIONS";
  req.path = path;
  req.headers = headers;
  return send(req);
}

Result Client::send_body(const char* method, const std::string& path, const Headers& headers, const std::string& body,
                         const std::string& content_type) {
  Request req;
  req.method = method;
  req.path = path;
  req.headers = headers;
  req.body = body;
  if (!content_type.empty() && !req.has_header("Content-Type")) req.headers.emplace("Content-Type", content_type);
  return send(req);
}

bool Client::send(Request& req, Response& res, Error& error) {
  Result r = send(static_cast<const Request&>(req));
  error = r.error();
  if (!r) return false;
  res = std::move(*r);
  return true;
}

Result Client::send(const Request& original) {
  std::string host = host_;
  int port = port_;
  Request req = original;
  for (const auto& [k, v] : default_headers_) {
    if (!req.has_header(k)) req.headers.emplace(k, v);
  }
  if (!req.has_header("Host")) {
    const bool default_port = (scheme_ == "https" && port == 443) || (scheme_ != "https" && port == 80);
    req.headers.emplace("Host", default_port ? host : host + ":" + std::to_string(port));
  }
  if (!req.body.empty() && !req.has_header("Content-Length")) {
    req.headers.emplace("Content-Length", std::to_string(req.body.size()));
  }
  if (!req.has_header("User-Agent")) req.headers.emplace("User-Agent", "cpp-httplib/" CPPHTTPLIB_VERSION);
  if (url_encode_) req.path = detail::encode_url(req.path);
  if (!valid_) return Result(nullptr, Error::Connection);
  Headers sent = req.headers;
  for (int redirects = 0;; redirects++) {
    const auto mapped = addr_map_.find(host);
    Server* server = detail::find_endpoint(mapped != addr_map_.end() ? mapped->second : host, port);
    if (server == nullptr) return Result(nullptr, Error::Connection, std::move(sent));
    req.target = req.path;
    req.local_port = port;
    Request copy = req;
    auto res = std::make_unique<Response>(server->handle(std::move(copy)));
    if (logger_) logger_(req, *res);
    const std::string location = res->get_header_value("Location");
    if (!follow_location_ || res->status < 300 || res->status >= 400 || location.empty()) {
      res->location = req.path;
      return Result(std::move(res), Error::Success, std::move(sent));
    }
    if (redirects >= 20) return Result(nullptr, Error::ExceedRedirectCount, std::move(sent));
    if (location.find("://") != std::string::npos) {
      Client next(location);
      host = next.host_;
      port = next.port_;
      const size_t start = location.find('/', location.find("://") + 3);
      req.path = start == std::string::npos ? "/" : location.substr(start);
    } else {
      req.path = location;
    }
    if (res->status == SeeOther_303 || ((res->status == 301 || res->status == 302) && req.method == "POST")) {
      req.method = "GET";
      req.body.clear();
    }
  }
}

}  // namespace httplib
