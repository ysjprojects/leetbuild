// The grpc++ model's compiled half (cppruntime/include/grpcpp): the in-process world every call goes
// through — learner servers by the port they listen on, harness peers by target, latency and
// failure rules, the log of calls — and the calls themselves. The rules are the Go runtime's
// (goruntime/models/grpc): a client's deadline or cancellation ends the call on both ends; an
// exception escaping a handler is UNKNOWN; injected failures and unreachable targets fail before
// any handler runs.
//
// Threads are green threads: code between two blocking calls runs alone, so the state here needs
// no locks. A call's every change wakes everyone waiting on it (Rpc::changed); each side waits for
// what it needs, bounded by the call's deadline on the virtual clock.
#include <grpcpp/grpcpp.h>
#include <grpcpp/impl/call_log.h>

#include <lb/runtime.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <deque>
#include <functional>
#include <limits>
#include <ostream>
#include <set>
#include <tuple>

namespace grpc {

const char* EnumName(StatusCode code) {
  switch (code) {
    case StatusCode::OK: return "OK";
    case StatusCode::CANCELLED: return "CANCELLED";
    case StatusCode::UNKNOWN: return "UNKNOWN";
    case StatusCode::INVALID_ARGUMENT: return "INVALID_ARGUMENT";
    case StatusCode::DEADLINE_EXCEEDED: return "DEADLINE_EXCEEDED";
    case StatusCode::NOT_FOUND: return "NOT_FOUND";
    case StatusCode::ALREADY_EXISTS: return "ALREADY_EXISTS";
    case StatusCode::PERMISSION_DENIED: return "PERMISSION_DENIED";
    case StatusCode::RESOURCE_EXHAUSTED: return "RESOURCE_EXHAUSTED";
    case StatusCode::FAILED_PRECONDITION: return "FAILED_PRECONDITION";
    case StatusCode::ABORTED: return "ABORTED";
    case StatusCode::OUT_OF_RANGE: return "OUT_OF_RANGE";
    case StatusCode::UNIMPLEMENTED: return "UNIMPLEMENTED";
    case StatusCode::INTERNAL: return "INTERNAL";
    case StatusCode::UNAVAILABLE: return "UNAVAILABLE";
    case StatusCode::DATA_LOSS: return "DATA_LOSS";
    case StatusCode::UNAUTHENTICATED: return "UNAUTHENTICATED";
    case StatusCode::DO_NOT_USE: return "DO_NOT_USE";
  }
  return "UNKNOWN";
}

static const Status kOkStatus;
const Status& Status::OK = kOkStatus;
const Status& Status::CANCELLED = *new Status(StatusCode::CANCELLED, "");

std::ostream& operator<<(std::ostream& out, const string_ref& s) { return out.write(s.data(), static_cast<std::streamsize>(s.size())); }

namespace internal {

constexpr double kNever = std::numeric_limits<double>::infinity();

std::chrono::system_clock::time_point from_ms(double ms) {
  if (ms == kNever) return std::chrono::system_clock::time_point::max();
  return std::chrono::system_clock::time_point(
      std::chrono::round<std::chrono::system_clock::duration>(std::chrono::duration<double, std::milli>(ms)));
}

Status MissingRequest() { return Status(StatusCode::INTERNAL, "grpc: the client sent no request message"); }
Status BadRequest() { return Status(StatusCode::INTERNAL, "grpc: error parsing the request message"); }

// A server's state, shared by the Server object and the calls in flight on it.
struct ServerState {
  std::vector<Service*> services;
  bool peer = false;      // a harness peer
  bool stopped = false;   // takes no more calls
  bool shut_down = false; // Shutdown finished: Wait returns
  std::set<Rpc*> active;
  ::lb::WaitQueue idle;     // Shutdown waiting for the calls in flight
  ::lb::WaitQueue waiting;  // Wait

  static std::string service_of(const std::string& path) {
    const size_t slash = path.rfind('/');
    return slash == std::string::npos || slash == 0 ? "" : path.substr(1, slash - 1);
  }
  bool has_service(const std::string& name) const {
    for (const Service* s : services) {
      for (const auto& m : s->lb_methods()) {
        if (service_of(m.path) == name) return true;
      }
    }
    return false;
  }
  bool serves(const std::string& path) const { return has_service(service_of(path)); }
  const Service::LbMethod* lookup(const std::string& path) const {
    for (const Service* s : services) {
      for (const auto& m : s->lb_methods()) {
        if (m.path == path) return &m;
      }
    }
    return nullptr;
  }
};

struct Rpc {
  std::string method;
  std::string target;
  bool client_streams = false;
  bool server_streams = false;
  lb::CallRecord* record = nullptr;
  double deadline = kNever;
  std::multimap<std::string, std::string> metadata;

  std::deque<std::string> to_server;
  std::deque<std::string> to_client;
  bool close_send = false;
  bool done = false;
  bool aborted = false;  // ended from the client's side (deadline, cancel) or a stopped server
  bool header_sent = false;
  Status status;
  std::multimap<std::string, std::string> header;
  std::multimap<std::string, std::string> trailer;
  std::shared_ptr<ServerState> server;
  ::lb::WaitQueue changed;

  void notify() { changed.notify_all(); }
  bool expired() const { return deadline != kNever && lb_now() >= deadline; }

  // Wait until cond holds (true) or virtual time reaches until (cond's value then).
  bool wait(const std::function<bool()>& cond, double until) {
    while (!cond()) {
      if (until == kNever) {
        changed.wait();
      } else {
        const double left = until - lb_now();
        if (left <= 0) return cond();
        changed.wait(left);
      }
    }
    return true;
  }

  void finish(Status st, bool from_client) {
    if (done) return;
    done = true;
    aborted = from_client;
    status = std::move(st);
    header_sent = true;
    record->Done = true;
    record->Code = status.error_code();
    record->Message = status.error_message();
    notify();
    if (server != nullptr) {
      server->active.erase(this);
      if (server->active.empty()) server->idle.notify_all();
    }
  }

  // The deadline passed: the call ends DEADLINE_EXCEEDED on both ends.
  bool expire() {
    if (!done && expired()) finish(Status(StatusCode::DEADLINE_EXCEEDED, "Deadline Exceeded"), true);
    return done;
  }
};

struct Access {
  static std::shared_ptr<Rpc>& rpc(ClientContext& c) { return c.rpc_; }
  static const std::shared_ptr<Rpc>& rpc(const ClientContext& c) { return c.rpc_; }
  static const std::multimap<std::string, std::string>& metadata(const ClientContext& c) { return c.metadata_; }
  static double deadline(const ClientContext& c) { return c.deadline_ms_; }
  static const std::shared_ptr<CallCredentials>& creds(const ClientContext& c) { return c.creds_; }
  static void bind(ServerContext& s, std::shared_ptr<Rpc> rpc) {
    for (const auto& [k, v] : rpc->metadata) s.client_metadata_.emplace(string_ref(k), string_ref(v));
    s.rpc_ = std::move(rpc);
  }
  static const std::shared_ptr<Rpc>& rpc(const ServerContext& s) { return s.rpc_; }
  static void view(const std::multimap<std::string, std::string>& from, std::multimap<std::string, std::string>& copy,
                   std::multimap<string_ref, string_ref>& view) {
    copy = from;
    view.clear();
    for (const auto& [k, v] : copy) view.emplace(string_ref(k), string_ref(v));
  }
};

}  // namespace internal

// ---- the registry ---------------------------------------------------------------------------

namespace {

using internal::Rpc;
using internal::ServerState;

struct Rule {
  std::string target;
  std::string path;
  bool operator<(const Rule& o) const { return std::tie(target, path) < std::tie(o.target, o.path); }
};

struct Registry {
  std::map<std::string, std::shared_ptr<ServerState>> learner;  // by listen key (the port)
  std::map<std::string, std::unique_ptr<Server>> peers;          // harness peers by target ("": any)
  std::vector<std::unique_ptr<Server>> stopped_peers;
  std::map<Rule, double> latency;  // ms
  std::map<Rule, std::deque<std::pair<StatusCode, std::string>>> failures;
  std::vector<std::unique_ptr<lb::CallRecord>> calls;
  int next_port = 40000;
};

Registry& reg() {
  static Registry r;
  return r;
}

// "dns:///keys:9000" → "keys:9000".
std::string normalize_target(const std::string& target) {
  for (const char* scheme : {"dns:", "passthrough:", "ipv4:", "ipv6:"}) {
    const std::string s(scheme);
    if (target.rfind(s, 0) == 0) {
      std::string rest = target.substr(s.size());
      if (rest.rfind("//", 0) == 0) {
        rest = rest.substr(2);
        const size_t slash = rest.find('/');
        return slash == std::string::npos ? rest : rest.substr(slash + 1);
      }
      return rest;
    }
  }
  return target;
}

// What a target or a listening address is reached by: its port, or "unix:path".
std::string listen_key(const std::string& address) {
  if (address.rfind("unix://", 0) == 0) return "unix:" + address.substr(7);
  if (address.rfind("unix:", 0) == 0) return address;
  const size_t colon = address.rfind(':');
  if (colon == std::string::npos) return "";
  const std::string port = address.substr(colon + 1);
  if (port.empty() || !std::all_of(port.begin(), port.end(), [](unsigned char c) { return std::isdigit(c); })) return "";
  return std::to_string(std::stoi(port));
}

std::string rule_path(const std::string& method) { return method.rfind('/', 0) == 0 ? method : "/" + method; }

std::string short_path(const std::string& path) {
  const size_t slash = path.rfind('/');
  return slash == std::string::npos ? path : path.substr(slash);
}

std::string lower_name(StatusCode code) {
  std::string name = EnumName(code);
  for (char& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return name;
}

// The server a call to path at target reaches: the peer at target, the learner server on its port,
// the any-target peer — the first serving path's service, else the first there is.
std::shared_ptr<ServerState> resolve(const std::string& path, const std::string& target) {
  Registry& r = reg();
  std::vector<std::shared_ptr<ServerState>> candidates;
  if (auto it = r.peers.find(target); it != r.peers.end()) candidates.push_back(it->second->lb_state());
  if (const std::string key = listen_key(target); !key.empty()) {
    if (auto it = r.learner.find(key); it != r.learner.end()) candidates.push_back(it->second);
  }
  if (auto it = r.peers.find(""); it != r.peers.end() && !target.empty()) candidates.push_back(it->second->lb_state());
  for (const auto& s : candidates) {
    if (s->serves(path)) return s;
  }
  return candidates.empty() ? nullptr : candidates.front();
}

template <class V>
V* lookup_rule(std::map<Rule, V>& rules, const std::string& path, const std::string& target,
               const std::function<bool(const V&)>& usable) {
  for (const std::string& t : {target, std::string()}) {
    for (const std::string& p : {path, short_path(path)}) {
      auto it = rules.find(Rule{t, p});
      if (it != rules.end() && usable(it->second)) return &it->second;
    }
    if (target.empty()) break;
  }
  return nullptr;
}

void halt(const std::shared_ptr<ServerState>& state, const char* why) {
  state->stopped = true;
  Registry& r = reg();
  for (auto it = r.learner.begin(); it != r.learner.end();) {
    it = it->second == state ? r.learner.erase(it) : std::next(it);
  }
  std::vector<Rpc*> active(state->active.begin(), state->active.end());
  for (Rpc* rpc : active) rpc->finish(Status(StatusCode::UNAVAILABLE, why), true);
}

// The handler's thread: the latency first (the call may end meanwhile), then the method.
void serve(const std::shared_ptr<Rpc>& rpc, const std::shared_ptr<ServerState>& server, double latency) {
  if (latency > 0) {
    rpc->wait([&] { return rpc->done; }, std::min(lb_now() + latency, rpc->deadline));
    if (rpc->done || rpc->expire()) return;
  }
  if (rpc->done) return;
  const Service::LbMethod* method = server->lookup(rpc->method);
  if (method == nullptr) {
    const std::string service = ServerState::service_of(rpc->method);
    const std::string name = rpc->method.substr(rpc->method.rfind('/') + 1);
    rpc->finish(Status(StatusCode::UNIMPLEMENTED, server->has_service(service)
                                                      ? "unknown method " + name + " for service " + service
                                                      : "unknown service " + service),
                false);
    return;
  }
  ServerContext context;
  internal::Access::bind(context, rpc);
  internal::ServerCall call(rpc);
  Status status;
  try {
    status = method->handler(&context, call);
  } catch (const std::exception&) {
    status = Status(StatusCode::UNKNOWN, "Unexpected error in RPC handling");
  } catch (...) {
    // Not the program's own exception (the harness failing the check): it goes on to fail it.
    rpc->finish(Status(StatusCode::UNKNOWN, "Unexpected error in RPC handling"), false);
    throw;
  }
  rpc->finish(status, false);
}

// A call begins: logged, then failed (deadline gone, injected failure, nothing serving) or on its
// way to the server's handler.
std::shared_ptr<Rpc> start(ChannelInterface* channel, const char* method, ClientContext* context, bool client_streams,
                           bool server_streams, const std::string* request) {
  Registry& r = reg();
  auto rpc = std::make_shared<Rpc>();
  rpc->method = method;
  rpc->target = channel->lb_target();
  rpc->client_streams = client_streams;
  rpc->server_streams = server_streams;
  rpc->metadata = internal::Access::metadata(*context);
  for (const auto* creds : {&channel->lb_call_credentials(), &internal::Access::creds(*context)}) {
    if (*creds != nullptr) rpc->metadata.insert((*creds)->lb_metadata().begin(), (*creds)->lb_metadata().end());
  }
  rpc->deadline = internal::Access::deadline(*context);
  internal::Access::rpc(*context) = rpc;

  auto record = std::make_unique<lb::CallRecord>();
  const double now = lb_now();
  record->Method = rpc->method;
  record->Target = rpc->target;
  record->Metadata = rpc->metadata;
  record->Started = internal::from_ms(now);
  record->FromHarness = channel->lb_harness();
  if (rpc->deadline != internal::kNever) {
    record->has_deadline = true;
    record->Deadline = internal::from_ms(rpc->deadline);
    record->Timeout = std::chrono::nanoseconds(std::llround((rpc->deadline - now) * 1e6));
  }
  if (request != nullptr) record->request = *request;
  rpc->record = record.get();
  r.calls.push_back(std::move(record));

  if (rpc->expire()) return rpc;
  auto* failures = lookup_rule<std::deque<std::pair<StatusCode, std::string>>>(
      r.failures, rpc->method, rpc->target, [](const auto& q) { return !q.empty(); });
  if (failures != nullptr) {
    const auto [code, details] = failures->front();
    failures->pop_front();
    rpc->finish(Status(code, details.empty() ? lower_name(code) : details), false);
    return rpc;
  }
  std::shared_ptr<ServerState> server = resolve(rpc->method, rpc->target);
  if (server == nullptr) {
    rpc->finish(Status(StatusCode::UNAVAILABLE, "failed to connect to all addresses; nothing serves " + rpc->method +
                                                    " at " + rpc->target),
                false);
    return rpc;
  }
  if (server->stopped) {
    rpc->finish(Status(StatusCode::UNAVAILABLE, "transport is closing"), false);
    return rpc;
  }
  if (request != nullptr) {
    rpc->to_server.push_back(*request);
    if (!client_streams) rpc->close_send = true;
  }
  rpc->server = server;
  server->active.insert(rpc.get());
  const double* latency = lookup_rule<double>(r.latency, rpc->method, rpc->target, [](const double&) { return true; });
  const double ms = latency == nullptr ? 0 : *latency;
  ::lb::spawn([rpc, server, ms] { serve(rpc, server, ms); });
  return rpc;
}

}  // namespace

// ---- the calls --------------------------------------------------------------------------------

namespace internal {

ClientCall::ClientCall(ChannelInterface* channel, const char* method, ClientContext* context, bool client_streams,
                       bool server_streams, const std::string* request)
    : rpc_(start(channel, method, context, client_streams, server_streams, request)) {}

bool ClientCall::Write(const std::string& message) {
  Rpc& r = *rpc_;
  if (!r.record->request.has_value()) r.record->request = message;
  if (r.done || r.close_send) return false;
  r.to_server.push_back(message);
  r.notify();
  return true;
}

bool ClientCall::WritesDone() {
  Rpc& r = *rpc_;
  if (!r.close_send) {
    r.close_send = true;
    r.notify();
  }
  return !r.done || r.status.ok();
}

bool ClientCall::Read(std::string* message) {
  Rpc& r = *rpc_;
  r.wait([&] { return !r.to_client.empty() || r.done; }, r.deadline);
  if (!r.to_client.empty() && !r.aborted) {
    *message = std::move(r.to_client.front());
    r.to_client.pop_front();
    return true;
  }
  r.expire();
  return false;
}

Status ClientCall::Finish(std::string* response) {
  Rpc& r = *rpc_;
  r.wait([&] { return r.done; }, r.deadline);
  r.expire();
  if (r.status.ok() && response != nullptr) {
    if (r.to_client.empty())
      return Status(StatusCode::INTERNAL, "cardinality violation: received no response message from non-server-streaming RPC");
    *response = r.to_client.front();
  }
  return r.status;
}

void ClientCall::WaitForInitialMetadata() {
  Rpc& r = *rpc_;
  r.wait([&] { return r.header_sent || r.done; }, r.deadline);
  r.expire();
}

Status UnaryCall(ChannelInterface* channel, const char* method, ClientContext* context, const std::string& request,
                 std::string* response) {
  ClientCall call(channel, method, context, false, false, &request);
  return call.Finish(response);
}

bool ServerCall::Read(std::string* message) {
  Rpc& r = *rpc_;
  r.wait([&] { return !r.to_server.empty() || r.close_send || r.done; }, r.deadline);
  if (!r.to_server.empty() && !r.aborted) {
    *message = std::move(r.to_server.front());
    r.to_server.pop_front();
    return true;
  }
  r.expire();
  return false;
}

bool ServerCall::Write(const std::string& message) {
  Rpc& r = *rpc_;
  if (r.done || r.expire()) return false;
  r.header_sent = true;
  r.to_client.push_back(message);
  r.notify();
  return true;
}

void ServerCall::SendInitialMetadata() {
  Rpc& r = *rpc_;
  if (!r.header_sent) {
    r.header_sent = true;
    r.notify();
  }
}

}  // namespace internal

// ---- contexts -------------------------------------------------------------------------------

ClientContext::ClientContext() : deadline_ms_(internal::kNever) {}

ClientContext::~ClientContext() { TryCancel(); }

std::unique_ptr<ClientContext> ClientContext::FromServerContext(const ServerContext& server_context,
                                                                PropagationOptions options) {
  auto out = std::make_unique<ClientContext>();
  const auto& rpc = internal::Access::rpc(server_context);
  if (options.deadline_propagation() && rpc != nullptr) out->deadline_ms_ = rpc->deadline;
  return out;
}

void ClientContext::AddMetadata(const std::string& meta_key, const std::string& meta_value) {
  metadata_.emplace(meta_key, meta_value);
}

void ClientContext::TryCancel() {
  if (rpc_ != nullptr && !rpc_->done) rpc_->finish(Status(StatusCode::CANCELLED, "Cancelled"), true);
}

const std::multimap<string_ref, string_ref>& ClientContext::GetServerInitialMetadata() const {
  static const std::multimap<std::string, std::string> none;
  internal::Access::view(rpc_ != nullptr ? rpc_->header : none, initial_, initial_view_);
  return initial_view_;
}

const std::multimap<string_ref, string_ref>& ClientContext::GetServerTrailingMetadata() const {
  static const std::multimap<std::string, std::string> none;
  internal::Access::view(rpc_ != nullptr && rpc_->done ? rpc_->trailer : none, trailing_, trailing_view_);
  return trailing_view_;
}

std::string ClientContext::peer() const { return rpc_ == nullptr ? "" : "ipv4:" + rpc_->target; }

std::chrono::system_clock::time_point ServerContext::deadline() const {
  return internal::from_ms(rpc_ == nullptr ? internal::kNever : rpc_->deadline);
}

void ServerContext::AddInitialMetadata(const std::string& key, const std::string& value) {
  if (rpc_ != nullptr) rpc_->header.emplace(key, value);
}

void ServerContext::AddTrailingMetadata(const std::string& key, const std::string& value) {
  if (rpc_ != nullptr) rpc_->trailer.emplace(key, value);
}

bool ServerContext::IsCancelled() const {
  if (rpc_ == nullptr) return false;
  rpc_->expire();
  return rpc_->aborted;
}

void ServerContext::TryCancel() const {
  if (rpc_ != nullptr && !rpc_->done) rpc_->finish(Status(StatusCode::CANCELLED, "Cancelled"), true);
}

std::string ServerContext::peer() const { return "ipv4:127.0.0.1:54321"; }

// ---- channels and credentials -----------------------------------------------------------------

Channel::Channel(std::string target, bool harness, std::shared_ptr<CallCredentials> call)
    : target_(std::move(target)), harness_(harness), call_(std::move(call)) {}

grpc_connectivity_state Channel::GetState(bool) {
  Registry& r = reg();
  const bool up = r.peers.count(target_) > 0 || r.learner.count(listen_key(target_)) > 0 || r.peers.count("") > 0;
  return up ? GRPC_CHANNEL_READY : GRPC_CHANNEL_TRANSIENT_FAILURE;
}

std::shared_ptr<Channel> CreateChannel(const std::string& target, const std::shared_ptr<ChannelCredentials>& creds) {
  return std::make_shared<Channel>(normalize_target(target), false, creds == nullptr ? nullptr : creds->lb_call());
}

std::shared_ptr<Channel> CreateCustomChannel(const std::string& target, const std::shared_ptr<ChannelCredentials>& creds,
                                             const ChannelArguments&) {
  return CreateChannel(target, creds);
}

std::shared_ptr<ChannelCredentials> InsecureChannelCredentials() { return std::make_shared<ChannelCredentials>(false); }
std::shared_ptr<ChannelCredentials> SslCredentials(const SslCredentialsOptions&) {
  return std::make_shared<ChannelCredentials>(true);
}
std::shared_ptr<ChannelCredentials> GoogleDefaultCredentials() { return std::make_shared<ChannelCredentials>(true); }
std::shared_ptr<CallCredentials> AccessTokenCredentials(const std::string& access_token) {
  return std::make_shared<CallCredentials>(std::multimap<std::string, std::string>{{"authorization", "Bearer " + access_token}});
}
std::shared_ptr<ChannelCredentials> CompositeChannelCredentials(const std::shared_ptr<ChannelCredentials>& channel_creds,
                                                                const std::shared_ptr<CallCredentials>& call_creds) {
  return std::make_shared<ChannelCredentials>(channel_creds != nullptr && channel_creds->lb_secure(), call_creds);
}
std::shared_ptr<CallCredentials> CompositeCallCredentials(const std::shared_ptr<CallCredentials>& a,
                                                          const std::shared_ptr<CallCredentials>& b) {
  std::multimap<std::string, std::string> md = a->lb_metadata();
  md.insert(b->lb_metadata().begin(), b->lb_metadata().end());
  return std::make_shared<CallCredentials>(std::move(md));
}
namespace experimental {
std::shared_ptr<ChannelCredentials> LocalCredentials(int) { return std::make_shared<ChannelCredentials>(false); }
}  // namespace experimental

std::shared_ptr<ServerCredentials> InsecureServerCredentials() { return std::make_shared<ServerCredentials>(false); }
std::shared_ptr<ServerCredentials> SslServerCredentials(const SslServerCredentialsOptions&) {
  return std::make_shared<ServerCredentials>(true);
}

void EnableDefaultHealthCheckService(bool) {}
namespace reflection {
void InitProtoReflectionServerBuilderPlugin() {}
}  // namespace reflection

// ---- servers --------------------------------------------------------------------------------

Server::Server(std::shared_ptr<internal::ServerState> state) : state_(std::move(state)) {}

Server::~Server() {
  if (!state_->shut_down) lb_shutdown(lb_now());
}

void Server::Wait() {
  while (!state_->shut_down) state_->waiting.wait();
}

void Server::Shutdown() { lb_shutdown(internal::kNever); }

void Server::lb_shutdown(double deadline_ms) {
  if (state_->shut_down) return;
  state_->stopped = true;
  Registry& r = reg();
  for (auto it = r.learner.begin(); it != r.learner.end();) {
    it = it->second == state_ ? r.learner.erase(it) : std::next(it);
  }
  while (!state_->active.empty()) {
    if (deadline_ms == internal::kNever) {
      state_->idle.wait();
    } else {
      const double left = deadline_ms - lb_now();
      if (left <= 0 || !state_->idle.wait(left)) break;
    }
  }
  halt(state_, "Server shutdown");
  state_->shut_down = true;
  state_->waiting.notify_all();
}

bool Server::RegisterService(Service* service) {
  state_->services.push_back(service);
  return true;
}

ServerBuilder& ServerBuilder::AddListeningPort(const std::string& addr_uri, std::shared_ptr<ServerCredentials>,
                                               int* selected_port) {
  ports_.emplace_back(addr_uri, selected_port);
  return *this;
}

ServerBuilder& ServerBuilder::RegisterService(Service* service) {
  services_.push_back(service);
  return *this;
}

std::unique_ptr<Server> ServerBuilder::BuildAndStart() {
  Registry& r = reg();
  auto state = std::make_shared<ServerState>();
  state->services = services_;
  std::vector<std::string> keys;
  for (const auto& [address, selected] : ports_) {
    std::string key = listen_key(address);
    if (key == "0") key = std::to_string(r.next_port++);
    if (key.empty() || r.learner.count(key) > 0) {
      if (selected != nullptr) *selected = 0;
      std::fprintf(stderr, "grpc: failed to add listening port %s: %s\n", address.c_str(),
                   key.empty() ? "no port in the address" : "the address is in use");
      return nullptr;
    }
    if (selected != nullptr) *selected = key.rfind("unix:", 0) == 0 ? 1 : std::stoi(key);
    keys.push_back(key);
  }
  for (const auto& key : keys) r.learner[key] = state;
  return std::make_unique<Server>(state);
}

// ---- the harness's hooks ----------------------------------------------------------------------

namespace lb {

Server* PeerServer(const std::string& target) {
  Registry& r = reg();
  const std::string t = normalize_target(target);
  auto& slot = r.peers[t];
  if (slot == nullptr) {
    auto state = std::make_shared<ServerState>();
    state->peer = true;
    slot = std::make_unique<Server>(state);
  }
  return slot.get();
}

void StopPeer(const std::string& target) {
  Registry& r = reg();
  auto it = r.peers.find(normalize_target(target));
  if (it == r.peers.end()) return;
  std::unique_ptr<Server> server = std::move(it->second);
  r.peers.erase(it);
  halt(server->lb_state(), "transport is closing");
  server->lb_state()->shut_down = true;
  r.stopped_peers.push_back(std::move(server));
}

void SetLatency(const std::string& method, double seconds, const std::string& target) {
  reg().latency[Rule{normalize_target(target), rule_path(method)}] = seconds * 1000;
}

void FailNext(const std::string& method, StatusCode code, const std::string& details, int times, const std::string& target) {
  auto& q = reg().failures[Rule{normalize_target(target), rule_path(method)}];
  for (int i = 0; i < times; ++i) q.emplace_back(code, details);
}

void ClearFailures() { reg().failures.clear(); }

std::vector<CallRecord> Calls() {
  std::vector<CallRecord> out;
  for (const auto& c : reg().calls) out.push_back(*c);
  return out;
}

std::vector<CallRecord> CallsTo(const std::string& method, const std::string& target) {
  const std::string suffix = rule_path(method);
  const std::string t = normalize_target(target);
  std::vector<CallRecord> out;
  for (const auto& c : reg().calls) {
    const bool matches = c->Method.size() >= suffix.size() &&
                         c->Method.compare(c->Method.size() - suffix.size(), suffix.size(), suffix) == 0;
    if (matches && (t.empty() || c->Target == t)) out.push_back(*c);
  }
  return out;
}

int LearnerCalls() {
  int n = 0;
  for (const auto& c : reg().calls) n += c->FromHarness ? 0 : 1;
  return n;
}

bool Serving(const std::string& method, const std::string& target) {
  const std::string path = rule_path(method);
  if (!target.empty()) {
    auto s = resolve(path, normalize_target(target));
    return s != nullptr && !s->stopped && s->serves(path);
  }
  Registry& r = reg();
  for (const auto& [key, s] : r.learner) {
    if (s->serves(path)) return true;
  }
  for (const auto& [t, s] : r.peers) {
    if (s->lb_state()->serves(path)) return true;
  }
  return false;
}

std::shared_ptr<Channel> HarnessChannel(const std::string& target) {
  return std::make_shared<Channel>(normalize_target(target), true);
}

}  // namespace lb

}  // namespace grpc
