// cpp-httplib (https://github.com/yhirose/cpp-httplib), as the LeetBuild C++ runtime models it: the
// same Server, Client, Request and Response API, with no sockets. Implemented in
// cppruntime/src/httplib.cpp (libleetbuild.a).
//
// Servers. A Server that listens registers itself with the runtime and waits (its thread blocks in
// listen() until stop(), as a real one does); the harness then sends it requests in process,
// through the same routing a real server applies: the pre-routing handler, the routes in
// registration order (regular expressions or `:param` patterns), the error, exception and
// post-routing handlers, then a streamed body's content provider. stop() closes the listener at
// once (no new connections); listen() returns once the requests in flight have finished, as real
// cpp-httplib drains its workers. An SSLServer is a Server that is TLS (is_ssl()), with its
// certificate and key paths and an SSL_CTX (the <openssl/ssl.h> model) for protocol settings.
//
// The network in process. Every listening server is an endpoint at its host:port; a Client's
// request goes to the endpoint at the client's host and port (an endpoint bound to a wildcard
// address — 0.0.0.0, ::, "" — answers for any host name on its port; an exact host name wins), on
// the calling thread, and fails with Error::Connection when nothing listens there. The harness's
// fakes of other services (an upstream LLM, a webhook receiver) are ordinary Servers made
// reachable with serve_in_process(host, port): an endpoint that does not block and is not one of
// the program's own listening servers.
#pragma once

#define CPPHTTPLIB_VERSION "0.18.0"

#include <algorithm>
#include <atomic>
#include <cassert>
#include <cctype>
#include <chrono>
#include <climits>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <exception>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <sys/types.h>

#include <lb/runtime.h>

// OpenSSL's context type, as <openssl/ssl.h> declares it (SSLServer::ssl_context()).
typedef struct ssl_ctx_st SSL_CTX;

#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/ssl.h>
#endif

namespace httplib {

namespace detail {

struct ci {
  bool operator()(const std::string& a, const std::string& b) const;
};

}  // namespace detail

using Headers = std::multimap<std::string, std::string, detail::ci>;
using Params = std::multimap<std::string, std::string>;
using Match = std::smatch;
using Ranges = std::vector<std::pair<ssize_t, ssize_t>>;

enum StatusCode {
  Continue_100 = 100,
  SwitchingProtocol_101 = 101,
  OK_200 = 200,
  Created_201 = 201,
  Accepted_202 = 202,
  NonAuthoritativeInformation_203 = 203,
  NoContent_204 = 204,
  ResetContent_205 = 205,
  PartialContent_206 = 206,
  MultipleChoices_300 = 300,
  MovedPermanently_301 = 301,
  Found_302 = 302,
  SeeOther_303 = 303,
  NotModified_304 = 304,
  TemporaryRedirect_307 = 307,
  PermanentRedirect_308 = 308,
  BadRequest_400 = 400,
  Unauthorized_401 = 401,
  PaymentRequired_402 = 402,
  Forbidden_403 = 403,
  NotFound_404 = 404,
  MethodNotAllowed_405 = 405,
  NotAcceptable_406 = 406,
  RequestTimeout_408 = 408,
  Conflict_409 = 409,
  Gone_410 = 410,
  LengthRequired_411 = 411,
  PreconditionFailed_412 = 412,
  PayloadTooLarge_413 = 413,
  UriTooLong_414 = 414,
  UnsupportedMediaType_415 = 415,
  RangeNotSatisfiable_416 = 416,
  ExpectationFailed_417 = 417,
  ImATeapot_418 = 418,
  UnprocessableContent_422 = 422,
  Locked_423 = 423,
  FailedDependency_424 = 424,
  TooEarly_425 = 425,
  UpgradeRequired_426 = 426,
  PreconditionRequired_428 = 428,
  TooManyRequests_429 = 429,
  RequestHeaderFieldsTooLarge_431 = 431,
  UnavailableForLegalReasons_451 = 451,
  InternalServerError_500 = 500,
  NotImplemented_501 = 501,
  BadGateway_502 = 502,
  ServiceUnavailable_503 = 503,
  GatewayTimeout_504 = 504,
  HttpVersionNotSupported_505 = 505,
};

const char* status_message(int status);

std::string get_header_value(const Headers& headers, const std::string& key, const char* def, size_t id);

struct MultipartFormData {
  std::string name;
  std::string content;
  std::string filename;
  std::string content_type;
};
using MultipartFormDataItems = std::vector<MultipartFormData>;
using MultipartFormDataMap = std::multimap<std::string, MultipartFormData>;

struct Request {
  std::string method;
  std::string path;
  std::string target;
  std::string version = "HTTP/1.1";
  Headers headers;
  std::string body;
  std::string remote_addr = "127.0.0.1";
  int remote_port = 50000;
  std::string local_addr = "127.0.0.1";
  int local_port = 8080;
  Params params;
  MultipartFormDataMap files;
  Ranges ranges;
  Match matches;
  std::unordered_map<std::string, std::string> path_params;
  // Model only: the client hangs up once it has read this many bytes of a streamed body (the
  // content provider's sink then stops being writable), as a browser closing an event stream.
  size_t client_reads = static_cast<size_t>(-1);

  bool has_header(const std::string& key) const { return headers.find(key) != headers.end(); }
  std::string get_header_value(const std::string& key, const char* def = "", size_t id = 0) const {
    return httplib::get_header_value(headers, key, def, id);
  }
  uint64_t get_header_value_u64(const std::string& key, uint64_t def = 0, size_t id = 0) const;
  size_t get_header_value_count(const std::string& key) const { return headers.count(key); }
  void set_header(const std::string& key, const std::string& val) { headers.emplace(key, val); }
  bool has_param(const std::string& key) const { return params.find(key) != params.end(); }
  std::string get_param_value(const std::string& key, size_t id = 0) const;
  size_t get_param_value_count(const std::string& key) const { return params.count(key); }
  bool is_multipart_form_data() const;
  bool has_file(const std::string& key) const { return files.find(key) != files.end(); }
  MultipartFormData get_file_value(const std::string& key) const;
};

class DataSink {
 public:
  DataSink();
  DataSink(const DataSink&) = delete;
  DataSink& operator=(const DataSink&) = delete;

  std::function<bool(const char* data, size_t size)> write;
  std::function<bool()> is_writable = [] { return true; };
  std::function<void()> done;
  std::function<void(const Headers& trailer)> done_with_trailer;
  std::ostream os;

 private:
  class Buffer : public std::streambuf {
   public:
    explicit Buffer(DataSink& sink) : sink_(sink) {}

   protected:
    std::streamsize xsputn(const char* s, std::streamsize n) override;
    int_type overflow(int_type c) override;

   private:
    DataSink& sink_;
  };
  Buffer buffer_;
};

using ContentProvider = std::function<bool(size_t offset, size_t length, DataSink& sink)>;
using ContentProviderWithoutLength = std::function<bool(size_t offset, DataSink& sink)>;
using ContentProviderResourceReleaser = std::function<void(bool success)>;

struct Response {
  std::string version = "HTTP/1.1";
  int status = -1;
  std::string reason;
  Headers headers;
  std::string body;
  std::string location;

  bool has_header(const std::string& key) const { return headers.find(key) != headers.end(); }
  std::string get_header_value(const std::string& key, const char* def = "", size_t id = 0) const {
    return httplib::get_header_value(headers, key, def, id);
  }
  uint64_t get_header_value_u64(const std::string& key, uint64_t def = 0, size_t id = 0) const;
  size_t get_header_value_count(const std::string& key) const { return headers.count(key); }
  void set_header(const std::string& key, const std::string& val);
  void set_redirect(const std::string& url, int stat = Found_302);
  void set_content(const char* s, size_t n, const std::string& content_type);
  void set_content(const std::string& s, const std::string& content_type);
  void set_content(std::string&& s, const std::string& content_type);
  // A streamed body: the provider runs once the handlers are done, as the response is written.
  void set_content_provider(size_t length, const std::string& content_type, ContentProvider provider,
                            ContentProviderResourceReleaser releaser = nullptr);
  void set_content_provider(const std::string& content_type, ContentProviderWithoutLength provider,
                            ContentProviderResourceReleaser releaser = nullptr);
  void set_chunked_content_provider(const std::string& content_type, ContentProviderWithoutLength provider,
                                    ContentProviderResourceReleaser releaser = nullptr);
  void set_file_content(const std::string& path, const std::string& content_type = "");

  // The streamed body's provider, run by the server (model internals).
  size_t content_length_ = 0;
  ContentProvider content_provider_;
  ContentProviderWithoutLength chunked_provider_;
  ContentProviderResourceReleaser content_provider_resource_releaser_;
  bool is_chunked_content_provider_ = false;
};

class Server;

namespace detail {

// Servers whose listen() is waiting: the program's listening sockets.
struct Listening {
  Server* server;
  std::string host;
  int port;
};

std::vector<Listening>& listening();

// Every server a Client can reach: the listening ones and the harness's in-process fakes.
std::vector<Listening>& endpoints();

// The server answering at host:port, or nullptr (an exact host first, then a wildcard address).
Server* find_endpoint(const std::string& host, int port);

std::string decode_url(const std::string& s, bool plus_as_space);
std::string encode_url(const std::string& s);
void parse_query_text(const std::string& query, Params& params);
std::string params_to_query_str(const Params& params);
std::string base64_encode(const std::string& in);

// A route's pattern: a regular expression the whole path must match, or with `:name` segments,
// named path parameters (cpp-httplib's two kinds of matcher).
class Matcher {
 public:
  explicit Matcher(const std::string& pattern);
  bool match(Request& req) const;

 private:
  struct Impl;
  std::shared_ptr<Impl> impl_;
};

}  // namespace detail

class Server {
 public:
  using Handler = std::function<void(const Request&, Response&)>;
  enum class HandlerResponse { Handled, Unhandled };
  using HandlerWithResponse = std::function<HandlerResponse(const Request&, Response&)>;
  using ExceptionHandler = std::function<void(const Request&, Response&, std::exception_ptr)>;
  using Logger = std::function<void(const Request&, const Response&)>;
  using Expect100ContinueHandler = std::function<int(const Request&, Response&)>;

  Server() = default;
  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;
  virtual ~Server();

  virtual bool is_valid() const { return true; }
  // Whether this server speaks TLS (an SSLServer).
  virtual bool is_ssl() const { return false; }

  Server& Get(const std::string& pattern, Handler handler) { return route("GET", pattern, std::move(handler)); }
  Server& Post(const std::string& pattern, Handler handler) { return route("POST", pattern, std::move(handler)); }
  Server& Put(const std::string& pattern, Handler handler) { return route("PUT", pattern, std::move(handler)); }
  Server& Patch(const std::string& pattern, Handler handler) { return route("PATCH", pattern, std::move(handler)); }
  Server& Delete(const std::string& pattern, Handler handler) { return route("DELETE", pattern, std::move(handler)); }
  Server& Options(const std::string& pattern, Handler handler) { return route("OPTIONS", pattern, std::move(handler)); }

  Server& set_pre_routing_handler(HandlerWithResponse handler) {
    pre_routing_ = std::move(handler);
    return *this;
  }
  Server& set_post_routing_handler(Handler handler) {
    post_routing_ = std::move(handler);
    return *this;
  }
  Server& set_error_handler(HandlerWithResponse handler) {
    error_ = std::move(handler);
    return *this;
  }
  Server& set_error_handler(Handler handler);
  Server& set_exception_handler(ExceptionHandler handler) {
    exception_ = std::move(handler);
    return *this;
  }
  Server& set_logger(Logger logger) {
    logger_ = std::move(logger);
    return *this;
  }
  Server& set_default_headers(Headers headers) {
    default_headers_ = std::move(headers);
    return *this;
  }
  Server& set_expect_100_continue_handler(Expect100ContinueHandler) { return *this; }
  // Socket tuning does not apply in process.
  template <class... A>
  Server& set_read_timeout(A&&...) {
    return *this;
  }
  template <class... A>
  Server& set_write_timeout(A&&...) {
    return *this;
  }
  template <class... A>
  Server& set_idle_interval(A&&...) {
    return *this;
  }
  Server& set_keep_alive_max_count(size_t) { return *this; }
  Server& set_keep_alive_timeout(time_t) { return *this; }
  Server& set_payload_max_length(size_t n) {
    payload_max_ = n;
    return *this;
  }
  Server& set_tcp_nodelay(bool) { return *this; }
  Server& set_address_family(int) { return *this; }
  Server& set_ipv6_v6only(bool) { return *this; }
  template <class F>
  Server& set_socket_options(F&&) {
    return *this;
  }
  bool set_mount_point(const std::string&, const std::string&, Headers = Headers()) { return false; }
  bool set_base_dir(const std::string&, const std::string& = "/") { return false; }
  bool remove_mount_point(const std::string&) { return false; }
  Server& set_file_extension_and_mimetype_mapping(const std::string&, const std::string&) { return *this; }

  // Thread pools do not apply: requests run on the client's thread.
  std::function<void*()> new_task_queue;

  bool bind_to_port(const std::string& host, int port, int socket_flags = 0);
  int bind_to_any_port(const std::string& host, int socket_flags = 0);
  // Serve until stop(): the server registers with the runtime and this thread waits; it returns
  // once stopped and every request in flight has finished.
  bool listen_after_bind();
  bool listen(const std::string& host, int port, int socket_flags = 0);
  bool is_running() const { return running_; }
  void wait_until_ready() const;
  // Close the listener now (no new requests reach it); listen() returns when the requests in
  // flight are done.
  void stop();

  // Model only: make this server reachable by Clients at host:port without blocking and without
  // it counting as one of the program's listening servers (the harness's fakes); stop() ends it.
  void serve_in_process(const std::string& host, int port);

  const std::string& host() const { return host_; }
  int port() const { return port_; }

  // A request, routed as the real server would; the harness's HTTP client and Clients send them here.
  Response handle(Request req);
  // A request that is in flight from now on (stop() leaves listen() waiting for it) and runs —
  // routing, handlers and all — only when the returned function is called, which returns its
  // response (calling it again returns an empty Response). For the harness: a client holding a
  // connection open across a shutdown.
  std::function<Response()> hold(Request req);
  // Requests in flight now.
  int in_flight() const { return in_flight_; }

 private:
  struct Route {
    std::string method;
    detail::Matcher matcher;
    Handler handler;
  };

  Server& route(const char* method, const std::string& pattern, Handler handler);
  Response process(Request req);
  bool routing(Request& req, Response& res);
  void finish();
  void forget();

  std::vector<Route> routes_;
  HandlerWithResponse pre_routing_;
  Handler post_routing_;
  HandlerWithResponse error_;
  ExceptionHandler exception_;
  Logger logger_;
  Headers default_headers_;
  size_t payload_max_ = 0;
  std::string host_;
  int port_ = 0;
  bool bound_ = false;
  bool running_ = false;
  bool stopped_ = false;
  int in_flight_ = 0;
  mutable lb::WaitQueue stop_wait_;
  mutable lb::WaitQueue ready_;
};

class SSLServer : public Server {
 public:
  SSLServer(const char* cert_path, const char* private_key_path, const char* client_ca_cert_file_path = nullptr,
            const char* client_ca_cert_dir_path = nullptr, const char* private_key_password = nullptr);
  ~SSLServer() override;

  bool is_valid() const override { return ctx_ != nullptr; }
  bool is_ssl() const override { return true; }
  // The TLS context: SSL_CTX_set_min_proto_version(svr.ssl_context(), TLS1_2_VERSION) and the like.
  SSL_CTX* ssl_context() const { return ctx_; }
  const std::string& cert_path() const { return cert_path_; }
  const std::string& key_path() const { return key_path_; }

 private:
  SSL_CTX* ctx_ = nullptr;
  std::string cert_path_;
  std::string key_path_;
};

// ---- the client ---------------------------------------------------------------------------------

enum class Error {
  Success = 0,
  Unknown,
  Connection,
  BindIPAddress,
  Read,
  Write,
  ExceedRedirectCount,
  Canceled,
  SSLConnection,
  SSLLoadingCerts,
  SSLServerVerification,
  SSLServerHostnameVerification,
  UnsupportedMultipartBoundaryChars,
  Compression,
  ConnectionTimeout,
  ProxyConnection,
};

std::string to_string(Error error);
std::ostream& operator<<(std::ostream& os, const Error& obj);

class Result {
 public:
  Result() = default;
  Result(std::unique_ptr<Response>&& res, Error err, Headers&& request_headers = Headers{})
      : res_(std::move(res)), err_(err), request_headers_(std::move(request_headers)) {}
  bool operator==(std::nullptr_t) const { return res_ == nullptr; }
  bool operator!=(std::nullptr_t) const { return res_ != nullptr; }
  explicit operator bool() const { return res_ != nullptr; }
  const Response& value() const { return *res_; }
  Response& value() { return *res_; }
  const Response& operator*() const { return *res_; }
  Response& operator*() { return *res_; }
  const Response* operator->() const { return res_.get(); }
  Response* operator->() { return res_.get(); }
  Error error() const { return err_; }
  bool has_request_header(const std::string& key) const { return request_headers_.find(key) != request_headers_.end(); }
  std::string get_request_header_value(const std::string& key, const char* def = "", size_t id = 0) const {
    return httplib::get_header_value(request_headers_, key, def, id);
  }
  size_t get_request_header_value_count(const std::string& key) const { return request_headers_.count(key); }

 private:
  std::unique_ptr<Response> res_;
  Error err_ = Error::Unknown;
  Headers request_headers_;
};

// A client of the servers in process (see the top of this file): `scheme://host:port`, `host:port`
// or `host`; requests run the target server's routing on this thread.
class Client {
 public:
  explicit Client(const std::string& scheme_host_port);
  Client(const std::string& scheme_host_port, const std::string& client_cert_path, const std::string& client_key_path);
  Client(const std::string& host, int port);
  Client(const std::string& host, int port, const std::string& client_cert_path, const std::string& client_key_path);
  Client(Client&&) = default;
  Client& operator=(Client&&) = default;
  virtual ~Client() = default;

  bool is_valid() const { return valid_; }

  Result Get(const std::string& path) { return Get(path, Headers()); }
  Result Get(const std::string& path, const Headers& headers);
  Result Get(const std::string& path, const Params& params, const Headers& headers);

  Result Head(const std::string& path) { return Head(path, Headers()); }
  Result Head(const std::string& path, const Headers& headers);

  Result Post(const std::string& path) { return Post(path, Headers(), std::string(), std::string()); }
  Result Post(const std::string& path, const Headers& headers) { return Post(path, headers, std::string(), std::string()); }
  Result Post(const std::string& path, const char* body, size_t content_length, const std::string& content_type) {
    return Post(path, Headers(), std::string(body, content_length), content_type);
  }
  Result Post(const std::string& path, const Headers& headers, const char* body, size_t content_length,
              const std::string& content_type) {
    return Post(path, headers, std::string(body, content_length), content_type);
  }
  Result Post(const std::string& path, const std::string& body, const std::string& content_type) {
    return Post(path, Headers(), body, content_type);
  }
  Result Post(const std::string& path, const Headers& headers, const std::string& body, const std::string& content_type) {
    return send_body("POST", path, headers, body, content_type);
  }
  Result Post(const std::string& path, const Params& params) { return Post(path, Headers(), params); }
  Result Post(const std::string& path, const Headers& headers, const Params& params) {
    return send_body("POST", path, headers, detail::params_to_query_str(params), "application/x-www-form-urlencoded");
  }

  Result Put(const std::string& path) { return Put(path, Headers(), std::string(), std::string()); }
  Result Put(const std::string& path, const char* body, size_t content_length, const std::string& content_type) {
    return Put(path, Headers(), std::string(body, content_length), content_type);
  }
  Result Put(const std::string& path, const std::string& body, const std::string& content_type) {
    return Put(path, Headers(), body, content_type);
  }
  Result Put(const std::string& path, const Headers& headers, const std::string& body, const std::string& content_type) {
    return send_body("PUT", path, headers, body, content_type);
  }
  Result Put(const std::string& path, const Params& params) { return Put(path, Headers(), params); }
  Result Put(const std::string& path, const Headers& headers, const Params& params) {
    return send_body("PUT", path, headers, detail::params_to_query_str(params), "application/x-www-form-urlencoded");
  }

  Result Patch(const std::string& path) { return Patch(path, Headers(), std::string(), std::string()); }
  Result Patch(const std::string& path, const char* body, size_t content_length, const std::string& content_type) {
    return Patch(path, Headers(), std::string(body, content_length), content_type);
  }
  Result Patch(const std::string& path, const std::string& body, const std::string& content_type) {
    return Patch(path, Headers(), body, content_type);
  }
  Result Patch(const std::string& path, const Headers& headers, const std::string& body,
               const std::string& content_type) {
    return send_body("PATCH", path, headers, body, content_type);
  }

  Result Delete(const std::string& path) { return Delete(path, Headers(), std::string(), std::string()); }
  Result Delete(const std::string& path, const Headers& headers) {
    return Delete(path, headers, std::string(), std::string());
  }
  Result Delete(const std::string& path, const char* body, size_t content_length, const std::string& content_type) {
    return Delete(path, Headers(), std::string(body, content_length), content_type);
  }
  Result Delete(const std::string& path, const std::string& body, const std::string& content_type) {
    return Delete(path, Headers(), body, content_type);
  }
  Result Delete(const std::string& path, const Headers& headers, const std::string& body,
                const std::string& content_type) {
    return send_body("DELETE", path, headers, body, content_type);
  }

  Result Options(const std::string& path) { return Options(path, Headers()); }
  Result Options(const std::string& path, const Headers& headers);

  // Any request (method, path, headers, body as set).
  Result send(const Request& req);
  bool send(Request& req, Response& res, Error& error);

  void stop() {}
  std::string host() const { return host_; }
  int port() const { return port_; }
  size_t is_socket_open() const { return 0; }

  void set_hostname_addr_map(std::map<std::string, std::string> addr_map) { addr_map_ = std::move(addr_map); }
  void set_default_headers(Headers headers) { default_headers_ = std::move(headers); }
  void set_header_writer(const std::function<ssize_t(void*, std::string&)>&) {}
  void set_address_family(int) {}
  void set_tcp_nodelay(bool) {}
  template <class F>
  void set_socket_options(F&&) {}
  // Timeouts: a request in process never waits on a socket.
  void set_connection_timeout(time_t, time_t = 0) {}
  template <class Rep, class Period>
  void set_connection_timeout(const std::chrono::duration<Rep, Period>&) {}
  void set_read_timeout(time_t, time_t = 0) {}
  template <class Rep, class Period>
  void set_read_timeout(const std::chrono::duration<Rep, Period>&) {}
  void set_write_timeout(time_t, time_t = 0) {}
  template <class Rep, class Period>
  void set_write_timeout(const std::chrono::duration<Rep, Period>&) {}
  void set_basic_auth(const std::string& username, const std::string& password);
  void set_bearer_token_auth(const std::string& token);
  void set_keep_alive(bool on) { keep_alive_ = on; }
  void set_follow_location(bool on) { follow_location_ = on; }
  void set_url_encode(bool on) { url_encode_ = on; }
  void set_compress(bool) {}
  void set_decompress(bool) {}
  void set_interface(const std::string&) {}
  void set_proxy(const std::string&, int) {}
  void set_proxy_basic_auth(const std::string&, const std::string&) {}
  void set_proxy_bearer_token_auth(const std::string&) {}
  void enable_server_certificate_verification(bool) {}
  void enable_server_hostname_verification(bool) {}
  void set_ca_cert_path(const std::string& = "", const std::string& = "") {}
  void set_logger(std::function<void(const Request&, const Response&)> logger) { logger_ = std::move(logger); }

 private:
  Result send_body(const char* method, const std::string& path, const Headers& headers, const std::string& body,
                   const std::string& content_type);

  std::string scheme_ = "http";
  std::string host_;
  int port_ = 80;
  bool valid_ = true;
  bool keep_alive_ = false;
  bool follow_location_ = false;
  bool url_encode_ = true;
  Headers default_headers_;
  std::map<std::string, std::string> addr_map_;
  std::function<void(const Request&, const Response&)> logger_;
};

class SSLClient : public Client {
 public:
  explicit SSLClient(const std::string& host) : Client(host, 443) {}
  SSLClient(const std::string& host, int port) : Client(host, port) {}
  SSLClient(const std::string& host, int port, const std::string& client_cert_path, const std::string& client_key_path)
      : Client(host, port, client_cert_path, client_key_path) {}
};

}  // namespace httplib
