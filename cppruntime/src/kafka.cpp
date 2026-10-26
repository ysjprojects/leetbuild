// The librdkafka C++ model's compiled half (cppruntime/include/librdkafka/rdkafkacpp.h). The clients'
// state lives in the runtime's Kafka bridge (src/lib/runtime/cpp/kafka.ts); here are the calls and
// the waits: a call that blocks (consume, poll, flush) waits on the virtual clock, for its timeout or
// the time the bridge says something may change by itself (a stall ending, a message timing out),
// and wakes early when another thread changed the broker.
#include <librdkafka/rdkafkacpp.h>

#include <lb/runtime.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <set>
#include <string_view>
#include <utility>

namespace RdKafka {

namespace lb_model {

// Woken whenever a call changed the broker or a client: records appended, offsets moved, a
// partition paused or resumed, a stall lifted. Every waiting call looks again.
lb::WaitQueue& changed() {
  static lb::WaitQueue queue;
  return queue;
}

void broker_changed() { changed().notify_all(); }

// Wait until the broker changes or ms of virtual time passed (ms < 0: no bound).
void wait_changed(double ms) {
  if (ms == 0) return;
  changed().wait(ms < 0 ? -1 : ms);
}

// A call into a client the program destroyed while this thread waited inside it: the thread stops
// here for good (it would otherwise run on in freed memory).
[[noreturn]] void park_forever() {
  static lb::WaitQueue never;
  for (;;) never.wait();
}

std::set<int>& live() {
  static std::set<int> ids;
  return ids;
}

lb::Json call(const char* op, const lb::Json& request) { return lb::call(op, request); }

// A call that changes the broker: waiting calls of other threads look again.
lb::Json change(const char* op, const lb::Json& request) {
  lb::Json reply = lb::call(op, request);
  broker_changed();
  return reply;
}

lb::Json object(std::initializer_list<std::pair<const char*, lb::Json>> fields) {
  lb::Json o = lb::Json::object();
  for (const auto& [k, v] : fields) o.set(k, v);
  return o;
}

// Bytes cross the JSON bridge as base64 (keys, values, header values: any bytes, a protobuf).
std::string to_base64(std::string_view bytes) {
  static const char* const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((bytes.size() + 2) / 3 * 4);
  for (size_t i = 0; i < bytes.size(); i += 3) {
    const size_t n = std::min<size_t>(3, bytes.size() - i);
    uint32_t chunk = 0;
    for (size_t k = 0; k < 3; k++)
      chunk = (chunk << 8) | (k < n ? static_cast<unsigned char>(bytes[i + k]) : 0);
    for (size_t k = 0; k < 4; k++) out += k <= n ? alphabet[(chunk >> (18 - 6 * k)) & 63] : '=';
  }
  return out;
}

std::string from_base64(std::string_view text) {
  std::string out;
  out.reserve(text.size() / 4 * 3);
  uint32_t chunk = 0;
  int bits = 0;
  for (const char c : text) {
    int v;
    if (c >= 'A' && c <= 'Z') v = c - 'A';
    else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
    else if (c >= '0' && c <= '9') v = c - '0' + 52;
    else if (c == '+' || c == '-') v = 62;
    else if (c == '/' || c == '_') v = 63;
    else continue;  // padding
    chunk = (chunk << 6) | static_cast<uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += static_cast<char>((chunk >> bits) & 0xff);
    }
  }
  return out;
}

lb::Json bytes(bool present, const std::string& s) { return present ? lb::Json(to_base64(s)) : lb::Json(); }

lb::Json partitions_json(const std::vector<TopicPartition*>& partitions) {
  lb::Json out = lb::Json::array();
  for (const TopicPartition* tp : partitions) {
    if (tp == nullptr) continue;
    out.push(object({{"topic", tp->topic()}, {"partition", tp->partition()}, {"offset", static_cast<double>(tp->offset())}}));
  }
  return out;
}

std::vector<TopicPartition*> partitions_of(const lb::Json& list) {
  std::vector<TopicPartition*> out;
  if (!list.is_array()) return out;
  for (const lb::Json& tp : list.items()) {
    out.push_back(TopicPartition::create(tp["topic"].as_string(), static_cast<int>(tp["partition"].as_int()),
                                         tp.has("offset") ? tp["offset"].as_int() : Topic::OFFSET_INVALID));
  }
  return out;
}

std::string conf_value(const std::map<std::string, std::string>& props, const std::string& name,
                       const std::string& fallback) {
  auto it = props.find(name);
  return it == props.end() ? fallback : it->second;
}

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

lb::Json conf_json(const Conf* conf) {
  lb::Json out = lb::Json::object();
  if (conf != nullptr)
    for (const auto& [k, v] : conf->properties()) out.set(k, v);
  return out;
}

// The time left until deadline (ms; -1: no deadline), at most until wake (-1: none).
double time_left(double deadline, double wake) {
  double wait = deadline < 0 ? -1 : deadline - lb_now();
  if (wake >= 0) {
    // At least a millisecond: a wake-up computed in doubles may read a hair before the instant.
    const double w = std::max(1.0, wake - lb_now());
    wait = wait < 0 ? w : std::min(wait, w);
  }
  return wait;
}

int next_name(bool producer) {
  static int producers = 0, consumers = 0;
  return producer ? ++producers : ++consumers;
}

Message* record_message(const lb::Json& r) {
  auto* m = new Message();
  m->topic_ = r["topic"].as_string();
  m->partition_ = static_cast<int32_t>(r["partition"].as_int());
  m->offset_ = r["offset"].as_int();
  m->has_key_ = !r["key"].is_null();
  m->key_ = from_base64(r["key"].as_string());
  m->has_value_ = !r["value"].is_null();
  m->value_ = from_base64(r["value"].as_string());
  if (r["headers"].is_array() && r["headers"].size() > 0) {
    m->headers_.reset(Headers::create());
    for (const lb::Json& h : r["headers"].items()) m->headers_->add(h[0].as_string(), from_base64(h[1].as_string()));
  }
  m->timestamp_ = {MessageTimestamp::MSG_TIMESTAMP_CREATE_TIME, r["timestamp"].as_int()};
  m->status_ = Message::MSG_STATUS_PERSISTED;
  return m;
}

Message* error_message(ErrorCode err) {
  auto* m = new Message();
  m->err_ = err;
  return m;
}

}  // namespace lb_model

using namespace lb_model;

// ---- library -----------------------------------------------------------------------------------------

int version() { return 0x020600ff; }
std::string version_str() { return "2.6.0"; }
std::string get_debug_contexts() { return "all,generic,broker,topic,metadata,feature,queue,msg,protocol,cgrp"; }
int wait_destroyed(int) { return 0; }
void* mem_malloc(size_t size) { return std::malloc(size); }
void mem_free(void* ptr) { std::free(ptr); }

std::string err2str(ErrorCode err) {
  switch (static_cast<int>(err)) {
#define LB_RDKAFKA_ERR(name, value, text) \
  case value:                             \
    return text;
#include <librdkafka/rdkafka_errors.inc>
#undef LB_RDKAFKA_ERR
    default:
      return "Err-" + std::to_string(static_cast<int>(err)) + "?";
  }
}

Error* Error::create(ErrorCode code, const std::string* errstr) {
  return new Error(code, errstr != nullptr ? *errstr : err2str(code));
}

std::string Error::name() const {
  switch (static_cast<int>(code_)) {
#define LB_RDKAFKA_ERR(name, value, text) \
  case value:                             \
    return #name;
#include <librdkafka/rdkafka_errors.inc>
#undef LB_RDKAFKA_ERR
    default:
      return "ERR_" + std::to_string(static_cast<int>(code_)) + "?";
  }
}

// ---- configuration -----------------------------------------------------------------------------------

Conf* Conf::create(ConfType type) { return new Conf(type); }

namespace {

bool one_of(const std::string& v, std::initializer_list<const char*> options) {
  return std::any_of(options.begin(), options.end(), [&](const char* o) { return v == o; });
}

bool is_number(const std::string& v) {
  if (v.empty()) return false;
  size_t i = v[0] == '-' ? 1 : 0;
  if (i == v.size()) return false;
  for (; i < v.size(); i++)
    if (v[i] < '0' || v[i] > '9') return false;
  return true;
}

bool numeric_property(const std::string& name) {
  for (const char* suffix : {".ms", ".messages", ".kbytes", ".bytes", ".max", ".retries"}) {
    const std::string s(suffix);
    if (name.size() >= s.size() && name.compare(name.size() - s.size(), s.size(), s) == 0) return true;
  }
  return name == "retries" || name == "batch.num.messages" || name == "batch.size";
}

}  // namespace

Conf::ConfResult Conf::set(const std::string& name, const std::string& value, std::string& errstr) {
  const std::string v = lower(value);
  bool valid = true;
  if (name == "acks" || name == "request.required.acks") {
    valid = one_of(v, {"all", "-1", "0", "1"});
  } else if (one_of(name, {"enable.idempotence", "enable.auto.commit", "enable.auto.offset.store",
                           "enable.partition.eof", "allow.auto.create.topics"})) {
    valid = one_of(v, {"true", "false", "1", "0"});
  } else if (name == "auto.offset.reset") {
    valid = one_of(v, {"smallest", "earliest", "beginning", "largest", "latest", "end", "error"});
  } else if (numeric_property(name)) {
    valid = is_number(value);
  }
  if (!valid) {
    errstr = "Invalid value \"" + value + "\" for configuration property \"" + name + "\"";
    return CONF_INVALID;
  }
  props_[name] = value;
  errstr.clear();
  return CONF_OK;
}

namespace {

template <class Cb>
Conf::ConfResult set_cb(const std::string& name, const char* expected, Cb* cb, Cb*& slot, std::string& errstr) {
  if (name != expected) {
    errstr = "Invalid value type, expected " + std::string(expected) + " for \"" + name + "\"";
    return Conf::CONF_INVALID;
  }
  slot = cb;
  errstr.clear();
  return Conf::CONF_OK;
}

}  // namespace

Conf::ConfResult Conf::set(const std::string& name, DeliveryReportCb* cb, std::string& errstr) {
  return set_cb(name, "dr_cb", cb, dr_cb_, errstr);
}
Conf::ConfResult Conf::set(const std::string& name, EventCb* cb, std::string& errstr) {
  return set_cb(name, "event_cb", cb, event_cb_, errstr);
}
Conf::ConfResult Conf::set(const std::string& name, PartitionerCb* cb, std::string& errstr) {
  return set_cb(name, "partitioner_cb", cb, partitioner_cb_, errstr);
}
Conf::ConfResult Conf::set(const std::string& name, PartitionerKeyPointerCb* cb, std::string& errstr) {
  return set_cb(name, "partitioner_key_pointer_cb", cb, partitioner_kp_cb_, errstr);
}
Conf::ConfResult Conf::set(const std::string& name, RebalanceCb* cb, std::string& errstr) {
  return set_cb(name, "rebalance_cb", cb, rebalance_cb_, errstr);
}
Conf::ConfResult Conf::set(const std::string& name, OffsetCommitCb* cb, std::string& errstr) {
  return set_cb(name, "offset_commit_cb", cb, offset_commit_cb_, errstr);
}
Conf::ConfResult Conf::set(const std::string& name, ConsumeCb* cb, std::string& errstr) {
  return set_cb(name, "consume_cb", cb, consume_cb_, errstr);
}

// The default topic configuration: its properties and partitioner become the client's.
Conf::ConfResult Conf::set(const std::string& name, const Conf* topic_conf, std::string& errstr) {
  if (name != "default_topic_conf" || topic_conf == nullptr) {
    errstr = "Invalid value type, expected default_topic_conf for \"" + name + "\"";
    return CONF_INVALID;
  }
  for (const auto& [k, v] : topic_conf->properties()) props_.emplace(k, v);
  if (topic_conf->partitioner_cb_ != nullptr) partitioner_cb_ = topic_conf->partitioner_cb_;
  if (topic_conf->partitioner_kp_cb_ != nullptr) partitioner_kp_cb_ = topic_conf->partitioner_kp_cb_;
  errstr.clear();
  return CONF_OK;
}

Conf::ConfResult Conf::get(const std::string& name, std::string& value) const {
  auto it = props_.find(name);
  if (it == props_.end()) return CONF_UNKNOWN;
  value = it->second;
  return CONF_OK;
}

Conf::ConfResult Conf::get(DeliveryReportCb*& cb) const {
  cb = dr_cb_;
  return CONF_OK;
}
Conf::ConfResult Conf::get(EventCb*& cb) const {
  cb = event_cb_;
  return CONF_OK;
}
Conf::ConfResult Conf::get(PartitionerCb*& cb) const {
  cb = partitioner_cb_;
  return CONF_OK;
}
Conf::ConfResult Conf::get(RebalanceCb*& cb) const {
  cb = rebalance_cb_;
  return CONF_OK;
}
Conf::ConfResult Conf::get(OffsetCommitCb*& cb) const {
  cb = offset_commit_cb_;
  return CONF_OK;
}

std::list<std::string>* Conf::dump() {
  auto* out = new std::list<std::string>();
  for (const auto& [k, v] : props_) {
    out->push_back(k);
    out->push_back(v);
  }
  return out;
}

// ---- records -----------------------------------------------------------------------------------------

Headers::Header::Header(const std::string& key, const void* value, size_t value_size)
    : key_(key),
      value_(value != nullptr ? std::string(static_cast<const char*>(value), value_size) : std::string()),
      null_(value == nullptr) {}

Headers::Header::Header(const std::string& key, const void* value, size_t value_size, const RdKafka::ErrorCode err)
    : Header(key, value, value_size) {
  err_ = err;
}

Headers* Headers::create() { return new Headers(); }

Headers* Headers::create(const std::vector<Header>& headers) {
  auto* h = new Headers();
  h->headers_ = headers;
  return h;
}

ErrorCode Headers::add(const std::string& key, const void* value, size_t value_size) {
  headers_.emplace_back(key, value, value_size);
  return ERR_NO_ERROR;
}

ErrorCode Headers::add(const std::string& key, const std::string& value) {
  headers_.emplace_back(key, value.data(), value.size());
  return ERR_NO_ERROR;
}

ErrorCode Headers::add(const Header& header) {
  headers_.push_back(header);
  return ERR_NO_ERROR;
}

ErrorCode Headers::remove(const std::string& key) {
  const size_t before = headers_.size();
  headers_.erase(std::remove_if(headers_.begin(), headers_.end(), [&](const Header& h) { return h.key() == key; }),
                 headers_.end());
  return headers_.size() == before ? ERR__NOENT : ERR_NO_ERROR;
}

std::vector<Headers::Header> Headers::get(const std::string& key) const {
  std::vector<Header> out;
  for (const Header& h : headers_)
    if (h.key() == key) out.push_back(h);
  return out;
}

Headers::Header Headers::get_last(const std::string& key) const {
  for (auto it = headers_.rbegin(); it != headers_.rend(); ++it)
    if (it->key() == key) return *it;
  return Header(key, nullptr, 0, ERR__NOENT);
}

Message::~Message() = default;

std::string Message::errstr() const { return errstr_.empty() ? err2str(err_) : errstr_; }

Headers* Message::headers(ErrorCode* err) {
  if (err != nullptr) *err = headers_ ? ERR_NO_ERROR : ERR__NOENT;
  return headers_.get();
}

TopicPartition* TopicPartition::create(const std::string& topic, int partition) {
  return new TopicPartition(topic, partition, Topic::OFFSET_INVALID);
}

TopicPartition* TopicPartition::create(const std::string& topic, int partition, int64_t offset) {
  return new TopicPartition(topic, partition, offset);
}

void TopicPartition::destroy(std::vector<TopicPartition*>& partitions) {
  for (TopicPartition* tp : partitions) delete tp;
  partitions.clear();
}

// ---- handles -----------------------------------------------------------------------------------------

ErrorCode Handle::pause(std::vector<TopicPartition*>&) { return ERR_NO_ERROR; }
ErrorCode Handle::resume(std::vector<TopicPartition*>&) { return ERR_NO_ERROR; }

ErrorCode Handle::query_watermark_offsets(const std::string& topic, int32_t partition, int64_t* low, int64_t* high,
                                          int) {
  return get_watermark_offsets(topic, partition, low, high);
}

ErrorCode Handle::get_watermark_offsets(const std::string& topic, int32_t partition, int64_t* low, int64_t* high) {
  const lb::Json r = call("kafka.watermarks", object({{"topic", topic}, {"partition", partition}}));
  if (low != nullptr) *low = r["low"].as_int();
  if (high != nullptr) *high = r["high"].as_int();
  return static_cast<ErrorCode>(r["err"].as_int());
}

void* Handle::mem_malloc(size_t size) { return std::malloc(size); }
void Handle::mem_free(void* ptr) { std::free(ptr); }

Topic* Topic::create(Handle* base, const std::string& topic_str, const Conf*, std::string& errstr) {
  errstr.clear();
  return new Topic(base, topic_str);
}

bool Topic::partition_available(int32_t partition) const {
  return partition >= 0 && partition < call("kafka.partitions", name_).as_int();
}

ErrorCode Topic::offset_store(int32_t partition, int64_t offset) {
  auto* consumer = dynamic_cast<KafkaConsumer*>(handle_);
  if (consumer == nullptr) return ERR__INVALID_ARG;
  std::vector<TopicPartition*> one{TopicPartition::create(name_, partition, offset)};
  const ErrorCode err = consumer->offsets_store(one);
  TopicPartition::destroy(one);
  return err;
}

// ---- producer ----------------------------------------------------------------------------------------

struct Producer::State {
  int id = 0;
  DeliveryReportCb* dr = nullptr;
  PartitionerCb* partitioner = nullptr;
  PartitionerKeyPointerCb* partitioner_kp = nullptr;
  // The records produced and not reported yet, by the id the bridge reports them with.
  struct Pending {
    std::string topic;
    Topic* topic_obj = nullptr;
    bool has_key = false;
    std::string key;
    bool has_value = false;
    std::string value;
    std::unique_ptr<Headers> headers;
    void* opaque = nullptr;
  };
  std::map<int64_t, Pending> pending;
  int64_t next_msg = 1;
  // Reports taken from the bridge and not handed to dr_cb yet (they still count in outq_len).
  int serving = 0;
  // When the bridge said something in flight may change by itself (-1: never).
  double wake = -1;
  // Topic handles for the partitioner callback, by name.
  std::map<std::string, std::unique_ptr<Topic>> topics;
};

Producer::Producer() : s_(std::make_unique<State>()) {}

Producer* Producer::create(const Conf* conf, std::string& errstr) {
  const std::map<std::string, std::string> none;
  const auto& props = conf != nullptr ? conf->properties() : none;
  const std::string acks = lower(conf_value(props, "acks", conf_value(props, "request.required.acks", "all")));
  const std::string idempotent = lower(conf_value(props, "enable.idempotence", "false"));
  if ((idempotent == "true" || idempotent == "1") && acks != "all" && acks != "-1") {
    errstr = "Failed to create producer: `acks` must be set to `all` when `enable.idempotence` is true";
    return nullptr;
  }
  auto* p = new Producer();
  p->s_->id = static_cast<int>(call("kafka.producer.new", object({{"conf", conf_json(conf)}})).as_int());
  if (conf != nullptr) {
    p->s_->dr = conf->dr_cb_;
    p->s_->partitioner = conf->partitioner_cb_;
    p->s_->partitioner_kp = conf->partitioner_kp_cb_;
  }
  p->name_ = "rdkafka#producer-" + std::to_string(next_name(true));
  live().insert(p->s_->id);
  errstr.clear();
  return p;
}

Producer::~Producer() {
  live().erase(s_->id);
  change("kafka.producer.close", object({{"id", s_->id}}));
}

ErrorCode Producer::enqueue(const std::string& topic, int32_t partition, int msgflags, const void* payload, size_t len,
                            const void* key, size_t key_len, bool has_key, int64_t timestamp, Headers* headers,
                            void* msg_opaque, Topic* topic_obj) {
  if (topic.empty()) return ERR__INVALID_ARG;
  State::Pending m;
  m.topic = topic;
  m.topic_obj = topic_obj;
  m.has_key = has_key;
  if (has_key && key != nullptr) m.key.assign(static_cast<const char*>(key), key_len);
  m.has_value = payload != nullptr;
  if (payload != nullptr) m.value.assign(static_cast<const char*>(payload), len);
  m.opaque = msg_opaque;
  if (partition == Topic::PARTITION_UA && (s_->partitioner != nullptr || s_->partitioner_kp != nullptr)) {
    const int32_t count = static_cast<int32_t>(call("kafka.partitions", topic).as_int());
    Topic* handle = topic_obj;
    if (handle == nullptr) {
      auto& slot = s_->topics[topic];
      if (!slot) {
        std::string err;
        slot.reset(Topic::create(this, topic, nullptr, err));
      }
      handle = slot.get();
    }
    partition = s_->partitioner != nullptr
                    ? s_->partitioner->partitioner_cb(handle, m.has_key ? &m.key : nullptr, count, msg_opaque)
                    : s_->partitioner_kp->partitioner_cb(handle, m.has_key ? m.key.data() : nullptr, m.key.size(),
                                                         count, msg_opaque);
  }
  lb::Json header_list = lb::Json::array();
  if (headers != nullptr)
    for (const Headers::Header& h : headers->get_all()) {
      lb::Json pair = lb::Json::array();
      pair.push(h.key());
      pair.push(to_base64(std::string_view(static_cast<const char*>(h.value()) != nullptr ? static_cast<const char*>(h.value()) : "",
                                           h.value_size())));
      header_list.push(pair);
    }
  const int64_t msg = s_->next_msg++;
  for (;;) {
    const lb::Json request = object({{"id", s_->id},
                                     {"msg", static_cast<double>(msg)},
                                     {"topic", topic},
                                     {"partition", partition},
                                     {"key", bytes(m.has_key, m.key)},
                                     {"value", bytes(m.has_value, m.value)},
                                     {"headers", header_list},
                                     {"timestamp", static_cast<double>(timestamp)}});
    const auto err = static_cast<ErrorCode>(change("kafka.producer.produce", request).as_int());
    if (err == ERR__QUEUE_FULL && (msgflags & RK_MSG_BLOCK) != 0) {
      poll(100);
      continue;
    }
    if (err != ERR_NO_ERROR) return err;
    break;
  }
  m.headers.reset(headers);  // the producer owns the headers once the record is accepted
  s_->pending.emplace(msg, std::move(m));
  if ((msgflags & RK_MSG_FREE) != 0 && payload != nullptr) std::free(const_cast<void*>(payload));
  return ERR_NO_ERROR;
}

ErrorCode Producer::produce(Topic* topic, int32_t partition, int msgflags, const void* payload, size_t len,
                            const std::string* key, void* msg_opaque) {
  if (topic == nullptr) return ERR__INVALID_ARG;
  return enqueue(topic->name(), partition, msgflags, payload, len, key != nullptr ? key->data() : nullptr,
                 key != nullptr ? key->size() : 0, key != nullptr, 0, nullptr, msg_opaque, topic);
}

ErrorCode Producer::produce(Topic* topic, int32_t partition, int msgflags, const void* payload, size_t len,
                            const void* key, size_t key_len, void* msg_opaque) {
  if (topic == nullptr) return ERR__INVALID_ARG;
  return enqueue(topic->name(), partition, msgflags, payload, len, key, key_len, key != nullptr, 0, nullptr,
                 msg_opaque, topic);
}

ErrorCode Producer::produce(const std::string topic_name, int32_t partition, int msgflags, const void* payload,
                            size_t len, const void* key, size_t key_len, int64_t timestamp, void* msg_opaque) {
  return enqueue(topic_name, partition, msgflags, payload, len, key, key_len, key != nullptr, timestamp, nullptr,
                 msg_opaque, nullptr);
}

ErrorCode Producer::produce(const std::string topic_name, int32_t partition, int msgflags, const void* payload,
                            size_t len, const void* key, size_t key_len, int64_t timestamp, Headers* headers,
                            void* msg_opaque) {
  return enqueue(topic_name, partition, msgflags, payload, len, key, key_len, key != nullptr, timestamp, headers,
                 msg_opaque, nullptr);
}

ErrorCode Producer::produce(Topic* topic, int32_t partition, const std::vector<char>* payload,
                            const std::vector<char>* key, void* msg_opaque) {
  if (topic == nullptr) return ERR__INVALID_ARG;
  return enqueue(topic->name(), partition, RK_MSG_COPY, payload != nullptr ? payload->data() : nullptr,
                 payload != nullptr ? payload->size() : 0, key != nullptr ? key->data() : nullptr,
                 key != nullptr ? key->size() : 0, key != nullptr, 0, nullptr, msg_opaque, topic);
}

// Hand the delivery reports the bridge has to dr_cb, in order; how many.
int Producer::serve() {
  const int id = s_->id;
  const lb::Json reply = call("kafka.producer.poll", object({{"id", id}}));
  s_->wake = reply["wake"].is_null() ? -1 : reply["wake"].as_number();
  const lb::Json& reports = reply["reports"];
  std::vector<std::unique_ptr<Message>> messages;
  for (const lb::Json& r : reports.items()) {
    auto m = std::make_unique<Message>();
    auto it = s_->pending.find(r["msg"].as_int());
    if (it != s_->pending.end()) {
      State::Pending& p = it->second;
      m->topic_ = p.topic;
      m->topic_obj_ = p.topic_obj;
      m->has_key_ = p.has_key;
      m->key_ = std::move(p.key);
      m->has_value_ = p.has_value;
      m->value_ = std::move(p.value);
      m->headers_ = std::move(p.headers);
      m->opaque_ = p.opaque;
      s_->pending.erase(it);
    }
    m->err_ = static_cast<ErrorCode>(r["err"].as_int());
    m->partition_ = static_cast<int32_t>(r["partition"].as_int());
    m->offset_ = r["offset"].as_int();
    m->timestamp_ = {MessageTimestamp::MSG_TIMESTAMP_CREATE_TIME, r["timestamp"].as_int()};
    m->status_ = static_cast<Message::Status>(r["status"].as_int());
    messages.push_back(std::move(m));
  }
  s_->serving += static_cast<int>(messages.size());
  int served = 0;
  for (auto& m : messages) {
    s_->serving -= 1;
    served += 1;
    if (s_->dr != nullptr) s_->dr->dr_cb(*m);
    if (!live().count(id)) park_forever();  // dr_cb destroyed the producer: nothing of it is left to touch
  }
  return served;
}

int Producer::poll(int timeout_ms) {
  const int id = s_->id;
  int served = serve();
  if (served > 0 || timeout_ms == 0) return served;
  const double deadline = timeout_ms < 0 ? -1 : lb_now() + timeout_ms;
  for (;;) {
    const double wait = time_left(deadline, s_->wake);
    if (deadline >= 0 && deadline - lb_now() <= 0) return 0;
    wait_changed(wait);
    if (!live().count(id)) park_forever();
    served = serve();
    if (served > 0) return served;
  }
}

int Producer::outq_len() {
  return static_cast<int>(call("kafka.producer.outq", object({{"id", s_->id}})).as_int()) + s_->serving;
}

ErrorCode Producer::flush(int timeout_ms) {
  const int id = s_->id;
  call("kafka.producer.flush", object({{"id", id}}));
  const double deadline = timeout_ms < 0 ? -1 : lb_now() + timeout_ms;
  for (;;) {
    serve();
    if (outq_len() == 0) return ERR_NO_ERROR;
    if (deadline >= 0 && deadline - lb_now() <= 0) return ERR__TIMED_OUT;
    wait_changed(time_left(deadline, s_->wake));
    if (!live().count(id)) park_forever();
  }
}

ErrorCode Producer::purge(int purge_flags) {
  change("kafka.producer.purge", object({{"id", s_->id}, {"flags", purge_flags}}));
  return ERR_NO_ERROR;
}

// ---- consumer ----------------------------------------------------------------------------------------

struct KafkaConsumer::State {
  int id = 0;
  std::string group;
  RebalanceCb* rebalance = nullptr;
  OffsetCommitCb* commit_cb = nullptr;
  // Whether the rebalance callback assigned (or unassigned) itself.
  bool assign_called = false;
  // Commit outcomes for offset_commit_cb, served in consume()/poll().
  std::vector<std::pair<ErrorCode, std::vector<TopicPartition*>>> commits;
};

KafkaConsumer::KafkaConsumer() : s_(std::make_unique<State>()) {}

KafkaConsumer* KafkaConsumer::create(const Conf* conf, std::string& errstr) {
  const std::map<std::string, std::string> none;
  const auto& props = conf != nullptr ? conf->properties() : none;
  const std::string group = conf_value(props, "group.id", "");
  if (group.empty()) {
    errstr = "\"group.id\" must be configured";
    return nullptr;
  }
  auto* c = new KafkaConsumer();
  c->s_->group = group;
  if (conf != nullptr) {
    c->s_->rebalance = conf->rebalance_cb_;
    c->s_->commit_cb = conf->offset_commit_cb_;
  }
  c->s_->id = static_cast<int>(call("kafka.consumer.new", object({{"conf", conf_json(conf)},
                                                                 {"rebalanceCb", c->s_->rebalance != nullptr},
                                                                 {"commitCb", c->s_->commit_cb != nullptr}}))
                                   .as_int());
  c->name_ = "rdkafka#consumer-" + std::to_string(next_name(false));
  live().insert(c->s_->id);
  errstr.clear();
  return c;
}

KafkaConsumer::~KafkaConsumer() {
  live().erase(s_->id);
  change("kafka.consumer.destroy", object({{"id", s_->id}}));
  for (auto& [err, offsets] : s_->commits) TopicPartition::destroy(offsets);
}

std::string KafkaConsumer::memberid() const { return "rdkafka-" + s_->group + "-" + std::to_string(s_->id); }

namespace {

// Hand the queued commit outcomes to offset_commit_cb; how many.
int serve_commits(KafkaConsumer::State& s, const lb::Json& from_bridge) {
  if (from_bridge.is_array())
    for (const lb::Json& c : from_bridge.items())
      s.commits.emplace_back(static_cast<ErrorCode>(c["err"].as_int()), partitions_of(c["offsets"]));
  auto queued = std::move(s.commits);
  s.commits.clear();
  for (auto& [err, offsets] : queued) {
    if (s.commit_cb != nullptr) s.commit_cb->offset_commit_cb(err, offsets);
    TopicPartition::destroy(offsets);
  }
  return static_cast<int>(queued.size());
}

}  // namespace

int KafkaConsumer::poll(int timeout_ms) {
  const int id = s_->id;
  const int served = serve_commits(*s_, lb::Json());
  if (served > 0 || timeout_ms == 0) return served;
  wait_changed(timeout_ms < 0 ? -1 : timeout_ms);
  if (!live().count(id)) park_forever();
  return serve_commits(*s_, lb::Json());
}

Message* KafkaConsumer::consume(int timeout_ms) {
  const int id = s_->id;
  const double deadline = timeout_ms < 0 ? -1 : lb_now() + timeout_ms;
  for (;;) {
    const lb::Json reply = call("kafka.consumer.poll", object({{"id", id}}));
    serve_commits(*s_, reply["commits"]);
    if (!live().count(id)) park_forever();
    if (reply.has("closed")) {
      // A closed consumer delivers nothing: its consume waits out the timeout.
      if (timeout_ms < 0) park_forever();
      if (timeout_ms > 0) lb_sleep(timeout_ms);
      return error_message(ERR__TIMED_OUT);
    }
    if (reply.has("rebalance")) {
      std::vector<TopicPartition*> revoked = partitions_of(reply["rebalance"]["revoked"]);
      std::vector<TopicPartition*> assigned = partitions_of(reply["rebalance"]["assigned"]);
      if (!revoked.empty()) {
        s_->assign_called = false;
        s_->rebalance->rebalance_cb(this, ERR__REVOKE_PARTITIONS, revoked);
        if (!live().count(id)) park_forever();
        if (!s_->assign_called) unassign();
      }
      s_->assign_called = false;
      s_->rebalance->rebalance_cb(this, ERR__ASSIGN_PARTITIONS, assigned);
      if (!live().count(id)) park_forever();
      if (!s_->assign_called) assign(assigned);
      TopicPartition::destroy(revoked);
      TopicPartition::destroy(assigned);
      continue;
    }
    if (reply.has("message")) {
      Message* m = record_message(reply["message"]);
      // librdkafka hands records over from its own threads: the program's other threads run
      // between two consumes, as they would.
      lb_yield();
      return m;
    }
    if (reply.has("eof")) {
      Message* m = error_message(ERR__PARTITION_EOF);
      m->topic_ = reply["eof"]["topic"].as_string();
      m->partition_ = static_cast<int32_t>(reply["eof"]["partition"].as_int());
      m->offset_ = reply["eof"]["offset"].as_int();
      return m;
    }
    if (timeout_ms == 0 || (deadline >= 0 && deadline - lb_now() <= 0)) return error_message(ERR__TIMED_OUT);
    wait_changed(time_left(deadline, -1));
    if (!live().count(id)) park_forever();
  }
}

ErrorCode KafkaConsumer::assignment(std::vector<TopicPartition*>& partitions) {
  for (TopicPartition* tp : partitions_of(call("kafka.consumer.assignment", object({{"id", s_->id}}))))
    partitions.push_back(tp);
  return ERR_NO_ERROR;
}

ErrorCode KafkaConsumer::subscription(std::vector<std::string>& topics) {
  const lb::Json reply = call("kafka.consumer.subscription", object({{"id", s_->id}}));
  for (const lb::Json& t : reply.items())
    topics.push_back(t.as_string());
  return ERR_NO_ERROR;
}

ErrorCode KafkaConsumer::subscribe(const std::vector<std::string>& topics) {
  if (topics.empty()) return ERR__INVALID_ARG;
  lb::Json list = lb::Json::array();
  for (const auto& t : topics) list.push(t);
  return static_cast<ErrorCode>(change("kafka.consumer.subscribe", object({{"id", s_->id}, {"topics", list}})).as_int());
}

ErrorCode KafkaConsumer::unsubscribe() {
  return static_cast<ErrorCode>(change("kafka.consumer.unsubscribe", object({{"id", s_->id}})).as_int());
}

ErrorCode KafkaConsumer::assign(const std::vector<TopicPartition*>& partitions) {
  s_->assign_called = true;
  return static_cast<ErrorCode>(
      change("kafka.consumer.assign", object({{"id", s_->id}, {"partitions", partitions_json(partitions)}})).as_int());
}

ErrorCode KafkaConsumer::unassign() {
  s_->assign_called = true;
  return static_cast<ErrorCode>(change("kafka.consumer.unassign", object({{"id", s_->id}})).as_int());
}

Error* KafkaConsumer::incremental_assign(const std::vector<TopicPartition*>& partitions) {
  s_->assign_called = true;
  change("kafka.consumer.incrementalAssign", object({{"id", s_->id}, {"partitions", partitions_json(partitions)}}));
  return nullptr;
}

Error* KafkaConsumer::incremental_unassign(const std::vector<TopicPartition*>& partitions) {
  s_->assign_called = true;
  change("kafka.consumer.incrementalUnassign", object({{"id", s_->id}, {"partitions", partitions_json(partitions)}}));
  return nullptr;
}

ErrorCode KafkaConsumer::commit(const std::vector<TopicPartition*>* offsets, OffsetCommitCb* cb, bool) {
  std::vector<TopicPartition*> committed =
      offsets != nullptr ? std::vector<TopicPartition*>()
                         : partitions_of(call("kafka.consumer.stored", object({{"id", s_->id}})));
  const lb::Json list = offsets != nullptr ? partitions_json(*offsets) : lb::Json();
  const auto err =
      static_cast<ErrorCode>(change("kafka.consumer.commit", object({{"id", s_->id}, {"offsets", list}})).as_int());
  if (offsets != nullptr) {
    for (TopicPartition* tp : *offsets)
      if (tp != nullptr) tp->set_err(err);
    for (const TopicPartition* tp : *offsets)
      if (tp != nullptr) committed.push_back(TopicPartition::create(tp->topic(), tp->partition(), tp->offset()));
  }
  if (cb != nullptr) {
    cb->offset_commit_cb(err, committed);
    TopicPartition::destroy(committed);
  } else if (s_->commit_cb != nullptr) {
    s_->commits.emplace_back(err, std::move(committed));
  } else {
    TopicPartition::destroy(committed);
  }
  return err;
}

ErrorCode KafkaConsumer::commitSync() { return commit(nullptr, nullptr, false); }
ErrorCode KafkaConsumer::commitAsync() { return commit(nullptr, nullptr, true); }

ErrorCode KafkaConsumer::commitSync(Message* message) {
  if (message == nullptr || message->err() != ERR_NO_ERROR) return ERR__INVALID_ARG;
  std::vector<TopicPartition*> one{TopicPartition::create(message->topic_name(), message->partition(), message->offset() + 1)};
  const ErrorCode err = commit(&one, nullptr, false);
  TopicPartition::destroy(one);
  return err;
}

ErrorCode KafkaConsumer::commitAsync(Message* message) {
  if (message == nullptr || message->err() != ERR_NO_ERROR) return ERR__INVALID_ARG;
  std::vector<TopicPartition*> one{TopicPartition::create(message->topic_name(), message->partition(), message->offset() + 1)};
  const ErrorCode err = commit(&one, nullptr, true);
  TopicPartition::destroy(one);
  return err;
}

ErrorCode KafkaConsumer::commitSync(std::vector<TopicPartition*>& offsets) { return commit(&offsets, nullptr, false); }

ErrorCode KafkaConsumer::commitAsync(const std::vector<TopicPartition*>& offsets) {
  return commit(&offsets, nullptr, true);
}

ErrorCode KafkaConsumer::commitSync(OffsetCommitCb* offset_commit_cb) {
  return commit(nullptr, offset_commit_cb, false);
}

ErrorCode KafkaConsumer::commitSync(std::vector<TopicPartition*>& offsets, OffsetCommitCb* offset_commit_cb) {
  return commit(&offsets, offset_commit_cb, false);
}

namespace {

// Copy the bridge's offsets (in request order) into partitions.
void fill_offsets(std::vector<TopicPartition*>& partitions, const lb::Json& reply) {
  size_t i = 0;
  for (TopicPartition* tp : partitions) {
    if (tp == nullptr) continue;
    if (i < reply.size()) tp->set_offset(reply[i]["offset"].as_int());
    tp->set_err(ERR_NO_ERROR);
    i++;
  }
}

}  // namespace

ErrorCode KafkaConsumer::committed(std::vector<TopicPartition*>& partitions, int) {
  fill_offsets(partitions,
               call("kafka.consumer.committed", object({{"id", s_->id}, {"partitions", partitions_json(partitions)}})));
  return ERR_NO_ERROR;
}

ErrorCode KafkaConsumer::position(std::vector<TopicPartition*>& partitions) {
  fill_offsets(partitions,
               call("kafka.consumer.position", object({{"id", s_->id}, {"partitions", partitions_json(partitions)}})));
  return ERR_NO_ERROR;
}

ErrorCode KafkaConsumer::close() {
  serve_commits(*s_, lb::Json());
  return static_cast<ErrorCode>(change("kafka.consumer.close", object({{"id", s_->id}})).as_int());
}

ErrorCode KafkaConsumer::seek(const TopicPartition& partition, int) {
  return static_cast<ErrorCode>(change("kafka.consumer.seek", object({{"id", s_->id},
                                                                      {"topic", partition.topic()},
                                                                      {"partition", partition.partition()},
                                                                      {"offset", static_cast<double>(partition.offset())}}))
                                    .as_int());
}

ErrorCode KafkaConsumer::offsets_store(std::vector<TopicPartition*>& offsets) {
  return static_cast<ErrorCode>(
      change("kafka.consumer.store", object({{"id", s_->id}, {"offsets", partitions_json(offsets)}})).as_int());
}

ErrorCode KafkaConsumer::set_paused(std::vector<TopicPartition*>& partitions, bool pause) {
  const auto err = static_cast<ErrorCode>(
      change("kafka.consumer.pause", object({{"id", s_->id}, {"partitions", partitions_json(partitions)}, {"pause", pause}}))
          .as_int());
  for (TopicPartition* tp : partitions)
    if (tp != nullptr) tp->set_err(err);
  return err;
}

ErrorCode KafkaConsumer::pause(std::vector<TopicPartition*>& partitions) { return set_paused(partitions, true); }
ErrorCode KafkaConsumer::resume(std::vector<TopicPartition*>& partitions) { return set_paused(partitions, false); }

}  // namespace RdKafka
