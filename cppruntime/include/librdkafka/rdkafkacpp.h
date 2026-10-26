// librdkafka's C++ API (namespace RdKafka) over the LeetBuild runtime's in-memory broker: the one
// every language's checks share (src/lib/runtime/ts/kafka.ts), reached through the runtime's Kafka
// bridge (src/lib/runtime/cpp/kafka.ts), where the clients' background state lives as librdkafka
// keeps it on its own threads. Implemented in cppruntime/src/kafka.cpp.
//
// As the real client behaves: produce() enqueues and returns; the delivery report reaches the
// DeliveryReportCb inside poll()/flush(); a stalled broker keeps records in flight until it answers
// or message.timeout.ms (default 300 s) passes; outq_len() counts records in flight and reports not
// served yet. KafkaConsumer::subscribe joins the group (its members split the partitions, range
// assignor); consume(timeout) delivers the next record round-robin over the unpaused assigned
// partitions, each starting at the group's committed offset, else auto.offset.reset (latest by
// default), waiting on the virtual clock for at most the timeout; with enable.auto.commit (default)
// the stored offsets (offset + 1 of every record handed over) are committed every
// auto.commit.interval.ms (5 s) and on close(). Keys, values and header values are bytes, any bytes.
#pragma once

#include <cstddef>
#include <cstdint>
#include <list>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace RdKafka {

class Handle;
class Producer;
class KafkaConsumer;
class Message;
class Topic;
class TopicPartition;
class Headers;
class Event;
class Conf;

int version();
std::string version_str();
std::string get_debug_contexts();
int wait_destroyed(int timeout_ms);
void* mem_malloc(size_t size);
void mem_free(void* ptr);

enum ErrorCode {
#define LB_RDKAFKA_ERR(name, value, text) ERR_##name = value,
#include <librdkafka/rdkafka_errors.inc>
#undef LB_RDKAFKA_ERR
  ERR__BEGIN = -200,
  ERR__END = -100,
  // The names older librdkafka releases gave the same codes.
  ERR_NOT_LEADER_OR_FOLLOWER = 6,
  ERR_GROUP_LOAD_IN_PROGRESS = 14,
  ERR_GROUP_COORDINATOR_NOT_AVAILABLE = 15,
  ERR_NOT_COORDINATOR_FOR_GROUP = 16,
};

std::string err2str(RdKafka::ErrorCode err);

// An error object (the transactional API's).
class Error {
 public:
  static Error* create(ErrorCode code, const std::string* errstr);
  virtual ~Error() = default;
  ErrorCode code() const { return code_; }
  std::string name() const;
  std::string str() const { return str_; }
  bool is_fatal() const { return false; }
  bool is_retriable() const { return false; }
  bool txn_requires_abort() const { return false; }

 private:
  Error(ErrorCode code, std::string str) : code_(code), str_(std::move(str)) {}
  ErrorCode code_;
  std::string str_;
};

// ---- callbacks the application implements --------------------------------------------------------

class DeliveryReportCb {
 public:
  virtual void dr_cb(Message& message) = 0;
  virtual ~DeliveryReportCb() = default;
};

class PartitionerCb {
 public:
  virtual int32_t partitioner_cb(const Topic* topic, const std::string* key, int32_t partition_cnt,
                                 void* msg_opaque) = 0;
  virtual ~PartitionerCb() = default;
};

class PartitionerKeyPointerCb {
 public:
  virtual int32_t partitioner_cb(const Topic* topic, const void* key, size_t key_len, int32_t partition_cnt,
                                 void* msg_opaque) = 0;
  virtual ~PartitionerKeyPointerCb() = default;
};

class EventCb {
 public:
  virtual void event_cb(Event& event) = 0;
  virtual ~EventCb() = default;
};

class Event {
 public:
  enum Type { EVENT_ERROR, EVENT_STATS, EVENT_LOG, EVENT_THROTTLE };
  enum Severity {
    EVENT_SEVERITY_EMERG = 0,
    EVENT_SEVERITY_ALERT = 1,
    EVENT_SEVERITY_CRITICAL = 2,
    EVENT_SEVERITY_ERROR = 3,
    EVENT_SEVERITY_WARNING = 4,
    EVENT_SEVERITY_NOTICE = 5,
    EVENT_SEVERITY_INFO = 6,
    EVENT_SEVERITY_DEBUG = 7
  };
  Event(Type type, ErrorCode err, std::string str) : type_(type), err_(err), str_(std::move(str)) {}
  virtual ~Event() = default;
  Type type() const { return type_; }
  ErrorCode err() const { return err_; }
  Severity severity() const { return EVENT_SEVERITY_ERROR; }
  std::string fac() const { return ""; }
  std::string str() const { return str_; }
  int throttle_time() const { return 0; }
  std::string broker_name() const { return "kafka:9092/1"; }
  int broker_id() const { return 1; }
  bool fatal() const { return false; }

 private:
  Type type_;
  ErrorCode err_;
  std::string str_;
};

class ConsumeCb {
 public:
  virtual void consume_cb(Message& message, void* opaque) = 0;
  virtual ~ConsumeCb() = default;
};

class RebalanceCb {
 public:
  virtual void rebalance_cb(RdKafka::KafkaConsumer* consumer, RdKafka::ErrorCode err,
                            std::vector<TopicPartition*>& partitions) = 0;
  virtual ~RebalanceCb() = default;
};

class OffsetCommitCb {
 public:
  virtual void offset_commit_cb(RdKafka::ErrorCode err, std::vector<TopicPartition*>& offsets) = 0;
  virtual ~OffsetCommitCb() = default;
};

// ---- configuration --------------------------------------------------------------------------------

class Conf {
 public:
  enum ConfType { CONF_GLOBAL, CONF_TOPIC };
  enum ConfResult { CONF_UNKNOWN = -2, CONF_INVALID = -1, CONF_OK = 0 };

  static Conf* create(ConfType type);
  virtual ~Conf() = default;

  // Properties are kept as given; the model validates those it reads (acks, the booleans, the
  // auto.offset.reset policy, the numbers) as librdkafka does.
  Conf::ConfResult set(const std::string& name, const std::string& value, std::string& errstr);
  Conf::ConfResult set(const std::string& name, DeliveryReportCb* dr_cb, std::string& errstr);
  Conf::ConfResult set(const std::string& name, EventCb* event_cb, std::string& errstr);
  Conf::ConfResult set(const std::string& name, const Conf* topic_conf, std::string& errstr);
  Conf::ConfResult set(const std::string& name, PartitionerCb* partitioner_cb, std::string& errstr);
  Conf::ConfResult set(const std::string& name, PartitionerKeyPointerCb* partitioner_kp_cb, std::string& errstr);
  Conf::ConfResult set(const std::string& name, RebalanceCb* rebalance_cb, std::string& errstr);
  Conf::ConfResult set(const std::string& name, OffsetCommitCb* offset_commit_cb, std::string& errstr);
  Conf::ConfResult set(const std::string& name, ConsumeCb* consume_cb, std::string& errstr);

  Conf::ConfResult get(const std::string& name, std::string& value) const;
  Conf::ConfResult get(DeliveryReportCb*& dr_cb) const;
  Conf::ConfResult get(EventCb*& event_cb) const;
  Conf::ConfResult get(PartitionerCb*& partitioner_cb) const;
  Conf::ConfResult get(RebalanceCb*& rebalance_cb) const;
  Conf::ConfResult get(OffsetCommitCb*& offset_commit_cb) const;
  std::list<std::string>* dump();

  // The model's view.
  ConfType type() const { return type_; }
  const std::map<std::string, std::string>& properties() const { return props_; }
  DeliveryReportCb* dr_cb_ = nullptr;
  EventCb* event_cb_ = nullptr;
  PartitionerCb* partitioner_cb_ = nullptr;
  PartitionerKeyPointerCb* partitioner_kp_cb_ = nullptr;
  RebalanceCb* rebalance_cb_ = nullptr;
  OffsetCommitCb* offset_commit_cb_ = nullptr;
  ConsumeCb* consume_cb_ = nullptr;

 private:
  explicit Conf(ConfType type) : type_(type) {}
  ConfType type_;
  std::map<std::string, std::string> props_;
};

// ---- records ----------------------------------------------------------------------------------------

class MessageTimestamp {
 public:
  enum MessageTimestampType { MSG_TIMESTAMP_NOT_AVAILABLE, MSG_TIMESTAMP_CREATE_TIME, MSG_TIMESTAMP_LOG_APPEND_TIME };
  MessageTimestampType type;
  int64_t timestamp;
};

class Headers {
 public:
  class Header {
   public:
    Header(const std::string& key, const void* value, size_t value_size);
    Header(const std::string& key, const void* value, size_t value_size, const RdKafka::ErrorCode err);
    Header(const Header& other) = default;
    Header& operator=(const Header& other) = default;
    std::string key() const { return key_; }
    // nullptr for a header without a value.
    const void* value() const { return null_ ? nullptr : value_.data(); }
    const char* value_string() const { return null_ ? nullptr : value_.c_str(); }
    size_t value_size() const { return value_.size(); }
    RdKafka::ErrorCode err() const { return err_; }

   private:
    std::string key_;
    std::string value_;
    bool null_ = false;
    RdKafka::ErrorCode err_ = ERR_NO_ERROR;
  };

  static Headers* create();
  static Headers* create(const std::vector<Header>& headers);
  virtual ~Headers() = default;

  ErrorCode add(const std::string& key, const void* value, size_t value_size);
  ErrorCode add(const std::string& key, const std::string& value);
  ErrorCode add(const Header& header);
  ErrorCode remove(const std::string& key);
  std::vector<Header> get(const std::string& key) const;
  // The last header called key; one whose err() is ERR__NOENT when there is none.
  Header get_last(const std::string& key) const;
  std::vector<Header> get_all() const { return headers_; }
  size_t size() const { return headers_.size(); }

 private:
  Headers() = default;
  std::vector<Header> headers_;
};

class Message {
 public:
  enum Status { MSG_STATUS_NOT_PERSISTED = 0, MSG_STATUS_POSSIBLY_PERSISTED = 1, MSG_STATUS_PERSISTED = 2 };

  virtual ~Message();
  Message(const Message&) = delete;
  Message& operator=(const Message&) = delete;

  std::string errstr() const;
  ErrorCode err() const { return err_; }
  Topic* topic() const { return topic_obj_; }
  std::string topic_name() const { return topic_; }
  int32_t partition() const { return partition_; }
  // nullptr for a tombstone (a record without a value).
  void* payload() const { return has_value_ ? const_cast<char*>(value_.data()) : nullptr; }
  size_t len() const { return value_.size(); }
  // nullptr for a record without a key.
  const std::string* key() const { return has_key_ ? &key_ : nullptr; }
  const void* key_pointer() const { return has_key_ ? key_.data() : nullptr; }
  size_t key_len() const { return key_.size(); }
  int64_t offset() const { return offset_; }
  MessageTimestamp timestamp() const { return timestamp_; }
  void* msg_opaque() const { return opaque_; }
  int64_t latency() const { return -1; }
  Status status() const { return status_; }
  // The record's headers (owned by the message), nullptr when it has none.
  RdKafka::Headers* headers() { return headers_.get(); }
  RdKafka::Headers* headers(RdKafka::ErrorCode* err);
  int32_t broker_id() const { return 1; }
  int32_t leader_epoch() const { return -1; }

  // The model's constructor (consume, delivery reports).
  Message() = default;
  ErrorCode err_ = ERR_NO_ERROR;
  std::string errstr_;
  std::string topic_;
  Topic* topic_obj_ = nullptr;
  int32_t partition_ = -1;
  int64_t offset_ = -1001;
  bool has_key_ = false;
  std::string key_;
  bool has_value_ = false;
  std::string value_;
  std::unique_ptr<Headers> headers_;
  MessageTimestamp timestamp_{MessageTimestamp::MSG_TIMESTAMP_NOT_AVAILABLE, -1};
  void* opaque_ = nullptr;
  Status status_ = MSG_STATUS_NOT_PERSISTED;
};

class TopicPartition {
 public:
  static TopicPartition* create(const std::string& topic, int partition);
  static TopicPartition* create(const std::string& topic, int partition, int64_t offset);
  // Delete every one and empty the vector.
  static void destroy(std::vector<TopicPartition*>& partitions);
  virtual ~TopicPartition() = default;

  const std::string& topic() const { return topic_; }
  int partition() const { return partition_; }
  int64_t offset() const { return offset_; }
  void set_offset(int64_t offset) { offset_ = offset; }
  ErrorCode err() const { return err_; }
  int32_t get_leader_epoch() { return -1; }
  void set_leader_epoch(int32_t) {}

  // The model's.
  void set_err(ErrorCode err) { err_ = err; }

 private:
  TopicPartition(std::string topic, int partition, int64_t offset)
      : topic_(std::move(topic)), partition_(partition), offset_(offset) {}
  std::string topic_;
  int partition_;
  int64_t offset_;
  ErrorCode err_ = ERR_NO_ERROR;
};

// ---- clients -----------------------------------------------------------------------------------------

class Handle {
 public:
  virtual ~Handle() = default;
  virtual std::string name() const = 0;
  virtual std::string memberid() const { return ""; }
  // Serve the client's callbacks, waiting at most timeout_ms for one; how many were served.
  virtual int poll(int timeout_ms) = 0;
  virtual int outq_len() { return 0; }
  virtual ErrorCode pause(std::vector<TopicPartition*>& partitions);
  virtual ErrorCode resume(std::vector<TopicPartition*>& partitions);
  // The partition's first offset (0: nothing is ever deleted here) and its end (the next offset).
  virtual ErrorCode query_watermark_offsets(const std::string& topic, int32_t partition, int64_t* low,
                                            int64_t* high, int timeout_ms);
  virtual ErrorCode get_watermark_offsets(const std::string& topic, int32_t partition, int64_t* low, int64_t* high);
  virtual void yield() {}
  virtual std::string clusterid(int timeout_ms) { return "leetbuild-kafka"; }
  virtual int32_t controllerid(int timeout_ms) { return 1; }
  virtual ErrorCode fatal_error(std::string& errstr) const { return ERR_NO_ERROR; }
  virtual void* mem_malloc(size_t size);
  virtual void mem_free(void* ptr);
};

class Topic {
 public:
  static constexpr int32_t PARTITION_UA = -1;
  static constexpr int64_t OFFSET_BEGINNING = -2;
  static constexpr int64_t OFFSET_END = -1;
  static constexpr int64_t OFFSET_STORED = -1000;
  static constexpr int64_t OFFSET_INVALID = -1001;

  static Topic* create(Handle* base, const std::string& topic_str, const Conf* conf, std::string& errstr);
  virtual ~Topic() = default;
  std::string name() const { return name_; }
  bool partition_available(int32_t partition) const;
  ErrorCode offset_store(int32_t partition, int64_t offset);

 private:
  Topic(Handle* handle, std::string name) : handle_(handle), name_(std::move(name)) {}
  Handle* handle_;
  std::string name_;
};

class Producer : public Handle {
 public:
  enum { RK_MSG_FREE = 0x1, RK_MSG_COPY = 0x2, RK_MSG_BLOCK = 0x4 };
  enum { PURGE_QUEUE = 0x1, PURGE_INFLIGHT = 0x2, PURGE_NON_BLOCKING = 0x4 };

  // nullptr (errstr says why) for a configuration librdkafka refuses.
  static Producer* create(const Conf* conf, std::string& errstr);
  ~Producer() override;

  std::string name() const override { return name_; }
  int poll(int timeout_ms) override;
  int outq_len() override;

  // Enqueue a record (partition: Topic::PARTITION_UA lets the partitioner pick, the CRC-32 of the key);
  // the delivery report arrives later, through the DeliveryReportCb, inside poll()/flush().
  ErrorCode produce(Topic* topic, int32_t partition, int msgflags, const void* payload, size_t len,
                    const std::string* key, void* msg_opaque);
  ErrorCode produce(Topic* topic, int32_t partition, int msgflags, const void* payload, size_t len,
                    const void* key, size_t key_len, void* msg_opaque);
  ErrorCode produce(const std::string topic_name, int32_t partition, int msgflags, const void* payload, size_t len,
                    const void* key, size_t key_len, int64_t timestamp, void* msg_opaque);
  // On success the producer owns headers (and deletes them); on failure the caller still does.
  ErrorCode produce(const std::string topic_name, int32_t partition, int msgflags, const void* payload, size_t len,
                    const void* key, size_t key_len, int64_t timestamp, RdKafka::Headers* headers,
                    void* msg_opaque);
  ErrorCode produce(Topic* topic, int32_t partition, const std::vector<char>* payload, const std::vector<char>* key,
                    void* msg_opaque);

  // Serve delivery reports until nothing is queued or in flight (ERR_NO_ERROR) or timeout_ms passed
  // (ERR__TIMED_OUT; outq_len() says what is left). -1: no bound.
  ErrorCode flush(int timeout_ms);
  // Fail what is queued (PURGE_QUEUE) or waiting for the broker (PURGE_INFLIGHT): their reports
  // carry ERR__PURGE_QUEUE / ERR__PURGE_INFLIGHT.
  ErrorCode purge(int purge_flags);

  struct State;

 private:
  Producer();
  ErrorCode enqueue(const std::string& topic, int32_t partition, int msgflags, const void* payload, size_t len,
                    const void* key, size_t key_len, bool has_key, int64_t timestamp, Headers* headers,
                    void* msg_opaque, Topic* topic_obj);
  int serve();
  std::unique_ptr<State> s_;
  std::string name_;
};

class KafkaConsumer : public Handle {
 public:
  // nullptr (errstr says why) without a group.id, or for a configuration librdkafka refuses.
  static KafkaConsumer* create(const Conf* conf, std::string& errstr);
  // Destroying a consumer that was not closed closes it (rd_kafka_destroy).
  ~KafkaConsumer() override;

  std::string name() const override { return name_; }
  std::string memberid() const override;
  // Serves offset-commit callbacks; records come from consume().
  int poll(int timeout_ms) override;
  ErrorCode pause(std::vector<TopicPartition*>& partitions) override;
  ErrorCode resume(std::vector<TopicPartition*>& partitions) override;

  ErrorCode assignment(std::vector<RdKafka::TopicPartition*>& partitions);
  ErrorCode subscription(std::vector<std::string>& topics);
  // Join the group with these topics (replacing the subscription); the assignment arrives in consume().
  ErrorCode subscribe(const std::vector<std::string>& topics);
  ErrorCode unsubscribe();
  ErrorCode assign(const std::vector<TopicPartition*>& partitions);
  ErrorCode unassign();
  Error* incremental_assign(const std::vector<TopicPartition*>& partitions);
  Error* incremental_unassign(const std::vector<TopicPartition*>& partitions);
  std::string rebalance_protocol() { return "EAGER"; }
  bool assignment_lost() { return false; }

  // The next record (the caller deletes it), or a message whose err() is ERR__TIMED_OUT after
  // timeout_ms (-1: no bound), ERR__PARTITION_EOF with enable.partition.eof.
  Message* consume(int timeout_ms);

  // The stored offsets of the assignment (each the offset after the last record handed over).
  ErrorCode commitSync();
  ErrorCode commitAsync();
  // message's offset + 1 on its partition.
  ErrorCode commitSync(Message* message);
  ErrorCode commitAsync(Message* message);
  // The offsets given (each the next offset to read).
  ErrorCode commitSync(std::vector<TopicPartition*>& offsets);
  ErrorCode commitAsync(const std::vector<TopicPartition*>& offsets);
  ErrorCode commitSync(OffsetCommitCb* offset_commit_cb);
  ErrorCode commitSync(std::vector<TopicPartition*>& offsets, OffsetCommitCb* offset_commit_cb);

  // The group's committed offsets (Topic::OFFSET_INVALID where there is none), the positions.
  ErrorCode committed(std::vector<TopicPartition*>& partitions, int timeout_ms);
  ErrorCode position(std::vector<TopicPartition*>& partitions);
  // Leave the group; with enable.auto.commit the stored offsets are committed first.
  ErrorCode close();
  // The next consume() of the partition starts at partition.offset().
  ErrorCode seek(const TopicPartition& partition, int timeout_ms);
  ErrorCode offsets_store(std::vector<TopicPartition*>& offsets);

  struct State;

 private:
  KafkaConsumer();
  ErrorCode commit(const std::vector<TopicPartition*>* offsets, OffsetCommitCb* cb, bool async);
  ErrorCode set_paused(std::vector<TopicPartition*>& partitions, bool pause);
  std::unique_ptr<State> s_;
  std::string name_;
};

}  // namespace RdKafka
