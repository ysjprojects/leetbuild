// The harness's control of the Kafka broker the learner's producers and consumers use (ctx.Kafka):
// the Go harness's Kafka API (goruntime/harness/kafka.go), over the broker every language's checks
// share (src/lib/runtime/ts/kafka.ts), reached through the runtime's Kafka bridge
// (src/lib/runtime/cpp/kafka.ts). Implemented in cppruntime/src/harness_kafka.cpp.
//
//   ctx.Kafka.Seed("orders", "o-1", R"({"id":1})")        a record from another producer
//   ctx.Kafka.Records("orders")                          what is on the topic, in production order
//   ctx.Kafka.Lag("ledger", "payments")                  records the group has not committed
//   ctx.Kafka.OnCommit([&](const std::string& group, const harness::KafkaOffsets& offsets) { … })
//   ctx.Kafka.StallFor("orders", 2)                      the broker acknowledges 2 s later
//
// Seeds and the harness's commits are not the learner's. Keys and values are bytes in a std::string:
// a key or value given as nullptr (or an empty optional) is absent, a JSON value (anything with
// dump()) is its text.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <ostream>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace harness {

class Ctx;

std::string FormatFloat(double v);

// A record header.
struct KafkaHeader {
  std::string Key;
  std::string Value;
  bool operator==(const KafkaHeader& o) const { return Key == o.Key && Value == o.Value; }
  friend std::ostream& operator<<(std::ostream& out, const KafkaHeader& h);
};

// A partition; String() is "topic|partition".
struct KafkaTopicPartition {
  std::string Topic;
  int Partition = 0;
  std::string String() const { return Topic + "|" + std::to_string(Partition); }
  bool operator<(const KafkaTopicPartition& o) const {
    return Topic != o.Topic ? Topic < o.Topic : Partition < o.Partition;
  }
  bool operator==(const KafkaTopicPartition& o) const { return Topic == o.Topic && Partition == o.Partition; }
  friend std::ostream& operator<<(std::ostream& out, const KafkaTopicPartition& tp) { return out << tp.String(); }
};

// Partitions to offsets: a commit, each offset the next one to read.
using KafkaOffsets = std::map<KafkaTopicPartition, int64_t>;

// A record on a partition: Key and Value are empty for a missing key or a tombstone; Seq is its
// place in the global production order.
struct KafkaRecord {
  std::string Topic;
  int Partition = 0;
  int64_t Offset = 0;
  std::optional<std::string> Key;
  std::optional<std::string> Value;
  std::vector<KafkaHeader> Headers;
  int64_t Timestamp = 0;
  int64_t Seq = 0;
  // The value of the header called name, if the record has one.
  std::optional<std::string> Header(const std::string& name) const;
  friend std::ostream& operator<<(std::ostream& out, const KafkaRecord& r);
};

// An entry of the broker's log: Kind is produce, seed, produce-failed, produce-stalled,
// produce-lost, produce-timed-out, ack-lost, failover, flush, producer, consumer, subscribe,
// deliver, commit, manual-commit, auto-commit or close; the other fields are set as the kind needs.
struct KafkaEvent {
  std::string Kind;
  std::string Group;
  std::string Topic;
  int Partition = 0;
  int64_t Offset = 0;
  std::vector<std::string> Topics;
  KafkaOffsets Offsets;
  int Lost = 0;
  std::string Client;
  friend std::ostream& operator<<(std::ostream& out, const KafkaEvent& e);
};

// A consumer the learner created: Client ("librdkafka"), Group, Topics (its subscription),
// AutoCommit and its interval (ms), Config (the properties it was created with), Assignment, Closed.
struct KafkaConsumer {
  std::string Client;
  std::string Group;
  std::vector<std::string> Topics;
  bool AutoCommit = false;
  int64_t AutoCommitInterval = 0;
  std::map<std::string, std::string> Config;
  std::vector<KafkaTopicPartition> Assignment;
  bool Closed = false;
};

namespace detail {

// A key or value as the broker stores it: text, absent (nullptr, an empty optional), a JSON value's
// text (anything with dump()), a number or a bool as JSON writes it.
template <class T>
std::optional<std::string> kafka_bytes(const T& v) {
  using D = std::decay_t<T>;
  if constexpr (std::is_same_v<D, std::nullptr_t>) {
    return std::nullopt;
  } else if constexpr (std::is_same_v<D, std::optional<std::string>>) {
    return v;
  } else if constexpr (std::is_convertible_v<const D&, std::string_view>) {
    return std::string(std::string_view(v));
  } else if constexpr (std::is_same_v<D, bool>) {
    return std::string(v ? "true" : "false");
  } else if constexpr (std::is_integral_v<D>) {
    return std::to_string(v);
  } else if constexpr (std::is_floating_point_v<D>) {
    return FormatFloat(static_cast<double>(v));
  } else {
    return std::string(v.dump());
  }
}

}  // namespace detail

class Kafka {
 public:
  explicit Kafka(Ctx& ctx) : ctx_(ctx) {}

  // Create topic with partitions partitions (<= 0: the default, 3) unless it exists. Topics are
  // otherwise created on first use with 3 partitions.
  void CreateTopic(const std::string& topic, int partitions);
  // The topics, in creation order.
  std::vector<std::string> Topics();
  // topic's partition count.
  int Partitions(const std::string& topic);
  // The partition the broker's partitioner puts key on (CRC-32 of the key modulo the partition
  // count: librdkafka's default partitioner).
  int PartitionFor(const std::string& topic, const std::optional<std::string>& key);

  // A record from another producer on topic, on the partition its key hashes to.
  template <class K, class V>
  KafkaRecord Seed(const std::string& topic, const K& key, const V& value, const std::vector<KafkaHeader>& headers = {}) {
    return SeedBytes(topic, -1, detail::kafka_bytes(key), detail::kafka_bytes(value), headers);
  }
  // Seed on a given partition.
  template <class K, class V>
  KafkaRecord SeedPartition(const std::string& topic, int partition, const K& key, const V& value,
                            const std::vector<KafkaHeader>& headers = {}) {
    return SeedBytes(topic, partition, detail::kafka_bytes(key), detail::kafka_bytes(value), headers);
  }
  KafkaRecord SeedBytes(const std::string& topic, int partition, const std::optional<std::string>& key,
                        const std::optional<std::string>& value, const std::vector<KafkaHeader>& headers);

  // Everything on topic, in production order.
  std::vector<KafkaRecord> Records(const std::string& topic);
  // The values / keys of Records(topic) as text ("" for none).
  std::vector<std::string> Values(const std::string& topic);
  std::vector<std::string> Keys(const std::string& topic);
  // The offset the next record of the partition gets.
  int64_t EndOffset(const std::string& topic, int partition);
  // The records of topic the group has not committed.
  int64_t Lag(const std::string& group, const std::string& topic);
  // The group's committed offset of the partition, -1 when it has none.
  int64_t CommittedOffset(const std::string& group, const std::string& topic, int partition);
  // The group's committed offset of the partition, if it has one.
  std::optional<int64_t> Committed(const std::string& group, const std::string& topic, int partition);
  // The offsets of every commit of group ("": every group), in order.
  std::vector<KafkaOffsets> Commits(const std::string& group);
  // Commit offsets for group as another member of the group would (the commit hooks run).
  void Commit(const std::string& group, const KafkaOffsets& offsets);
  // hook(group, offsets) at every commit, before the committing call returns (an auto-commit's runs
  // on a thread of its own): snapshot other state there to prove the commit came after the work.
  void OnCommit(std::function<void(const std::string& group, const KafkaOffsets& offsets)> hook);
  // hook(group, topics) when a consumer joins a group (subscribe), before it reads anything.
  void OnSubscribe(std::function<void(const std::string& group, const std::vector<std::string>& topics)> hook);

  // The next times produces to topic fail: the delivery report carries ERR__MSG_TIMED_OUT.
  void FailNext(const std::string& topic, int times);
  // The broker stops acknowledging produces to topic ("": every topic) until Resume.
  void Stall(const std::string& topic);
  // Stall for seconds of virtual time: the broker answers again afterwards.
  void StallFor(const std::string& topic, double seconds);
  // End the stall of topic ("": every stall); waiting records are delivered.
  void Resume(const std::string& topic);
  // The next times produce requests to topic are written but their acknowledgement is lost: the
  // producer retries, which writes the record again unless it is idempotent.
  void LoseAcks(const std::string& topic, int times);
  // Fail the partition leaders of topic ("": every topic): records acknowledged by the leader alone
  // (acks 0 or 1) within the last 100 ms are gone. How many were lost.
  int Failover(const std::string& topic);

  // The broker's log so far, and its entries of the given kinds.
  std::vector<KafkaEvent> Events();
  template <class... K>
  std::vector<KafkaEvent> EventsOf(const K&... kinds) {
    return EventsOfKinds({std::string(kinds)...});
  }
  std::vector<KafkaEvent> EventsOfKinds(const std::vector<std::string>& kinds);
  // Every consumer the learner created in this check, in creation order.
  std::vector<KafkaConsumer> Consumers();
  // The producer flushes so far.
  int Flushes();

 private:
  Ctx& ctx_;
};

}  // namespace harness
