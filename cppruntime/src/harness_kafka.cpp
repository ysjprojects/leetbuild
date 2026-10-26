// The harness's ctx.Kafka (cppruntime/include/leetbuild/kafka.h) over the runtime's Kafka bridge
// (src/lib/runtime/cpp/kafka.ts).
#include <leetbuild/harness.h>

namespace RdKafka::lb_model {
// cppruntime/src/kafka.cpp: wake the learner's clients waiting on the broker.
void broker_changed();
// Bytes on the bridge: base64.
std::string to_base64(std::string_view bytes);
std::string from_base64(std::string_view text);
}  // namespace RdKafka::lb_model

namespace harness {

namespace {

lb::Json object(std::initializer_list<std::pair<const char*, lb::Json>> fields) {
  lb::Json o = lb::Json::object();
  for (const auto& [k, v] : fields) o.set(k, v);
  return o;
}

// Bytes as the bridge carries them: base64, null for none.
lb::Json text(const std::optional<std::string>& s) { return s ? lb::Json(RdKafka::lb_model::to_base64(*s)) : lb::Json(); }

std::optional<std::string> optional_text(const lb::Json& v) {
  if (v.is_null()) return std::nullopt;
  return RdKafka::lb_model::from_base64(v.as_string());
}

// A call that changes the broker: the learner's waiting clients look again.
lb::Json change(const char* op, const lb::Json& request) {
  lb::Json reply = lb::call(op, request);
  RdKafka::lb_model::broker_changed();
  return reply;
}

KafkaRecord record_of(const lb::Json& r) {
  KafkaRecord out;
  out.Topic = r["topic"].as_string();
  out.Partition = static_cast<int>(r["partition"].as_int());
  out.Offset = r["offset"].as_int();
  out.Key = optional_text(r["key"]);
  out.Value = optional_text(r["value"]);
  for (const lb::Json& h : r["headers"].items())
    out.Headers.push_back({h[0].as_string(), RdKafka::lb_model::from_base64(h[1].as_string())});
  out.Timestamp = r["timestamp"].as_int();
  out.Seq = r["seq"].as_int();
  return out;
}

KafkaOffsets offsets_of(const lb::Json& o) {
  KafkaOffsets out;
  if (!o.is_object()) return out;
  for (const auto& [key, offset] : o.fields()) {
    const size_t bar = key.rfind('|');
    out[KafkaTopicPartition{key.substr(0, bar), std::stoi(key.substr(bar + 1))}] = offset.as_int();
  }
  return out;
}

lb::Json offsets_json(const KafkaOffsets& offsets) {
  lb::Json out = lb::Json::object();
  for (const auto& [tp, offset] : offsets) out.set(tp.String(), static_cast<double>(offset));
  return out;
}

std::vector<std::string> strings_of(const lb::Json& list) {
  std::vector<std::string> out;
  if (list.is_array())
    for (const lb::Json& s : list.items()) out.push_back(s.as_string());
  return out;
}

// A hook the bridge runs on the calling thread (invocable: its arguments read back) or, outside
// any call of the program's, on a thread of its own (receiver: its arguments as the payload).
template <class F>
lb::Json hook(F run) {
  const int invoke = lb::invocable([run] { run(lb::call("kafka.hookArgs")); });
  const int deliver = lb::receiver([run](const std::string& payload) {
    try {
      run(lb::Json::parse(payload));
    } catch (...) {
      ReportCurrentException("uncaught exception in a Kafka hook:");
    }
  });
  return object({{"invoke", invoke}, {"deliver", deliver}});
}

}  // namespace

std::ostream& operator<<(std::ostream& out, const KafkaHeader& h) { return out << '{' << h.Key << ' ' << h.Value << '}'; }

std::ostream& operator<<(std::ostream& out, const KafkaRecord& r) {
  return out << '{' << r.Topic << ' ' << r.Partition << ' ' << r.Offset << ' ' << Value(r.Key) << ' '
             << Value(r.Value) << ' ' << Value(r.Headers) << '}';
}

std::ostream& operator<<(std::ostream& out, const KafkaEvent& e) {
  out << '{' << e.Kind;
  if (!e.Group.empty()) out << " group=" << e.Group;
  if (!e.Topic.empty()) out << " topic=" << e.Topic << " partition=" << e.Partition << " offset=" << e.Offset;
  if (!e.Topics.empty()) out << " topics=" << Value(e.Topics);
  if (!e.Offsets.empty()) out << " offsets=" << Value(e.Offsets);
  return out << '}';
}

std::optional<std::string> KafkaRecord::Header(const std::string& name) const {
  for (const KafkaHeader& h : Headers)
    if (h.Key == name) return h.Value;
  return std::nullopt;
}

void Kafka::CreateTopic(const std::string& topic, int partitions) {
  change("kafka.createTopic", object({{"topic", topic}, {"partitions", partitions}}));
}

std::vector<std::string> Kafka::Topics() { return strings_of(lb::call("kafka.topics")); }

int Kafka::Partitions(const std::string& topic) { return static_cast<int>(lb::call("kafka.partitions", topic).as_int()); }

int Kafka::PartitionFor(const std::string& topic, const std::optional<std::string>& key) {
  return static_cast<int>(lb::call("kafka.partitionFor", object({{"topic", topic}, {"key", text(key)}})).as_int());
}

KafkaRecord Kafka::SeedBytes(const std::string& topic, int partition, const std::optional<std::string>& key,
                             const std::optional<std::string>& value, const std::vector<KafkaHeader>& headers) {
  lb::Json list = lb::Json::array();
  for (const KafkaHeader& h : headers) {
    lb::Json pair = lb::Json::array();
    pair.push(h.Key);
    pair.push(RdKafka::lb_model::to_base64(h.Value));
    list.push(pair);
  }
  return record_of(change("kafka.seed", object({{"topic", topic},
                                               {"partition", partition},
                                               {"key", text(key)},
                                               {"value", text(value)},
                                               {"headers", list}})));
}

std::vector<KafkaRecord> Kafka::Records(const std::string& topic) {
  std::vector<KafkaRecord> out;
  const lb::Json reply = lb::call("kafka.records", topic);
  for (const lb::Json& r : reply.items()) out.push_back(record_of(r));
  return out;
}

std::vector<std::string> Kafka::Values(const std::string& topic) {
  std::vector<std::string> out;
  for (const KafkaRecord& r : Records(topic)) out.push_back(r.Value.value_or(""));
  return out;
}

std::vector<std::string> Kafka::Keys(const std::string& topic) {
  std::vector<std::string> out;
  for (const KafkaRecord& r : Records(topic)) out.push_back(r.Key.value_or(""));
  return out;
}

int64_t Kafka::EndOffset(const std::string& topic, int partition) {
  return lb::call("kafka.endOffset", object({{"topic", topic}, {"partition", partition}})).as_int();
}

int64_t Kafka::Lag(const std::string& group, const std::string& topic) {
  return lb::call("kafka.lag", object({{"group", group}, {"topic", topic}})).as_int();
}

std::optional<int64_t> Kafka::Committed(const std::string& group, const std::string& topic, int partition) {
  const lb::Json r = lb::call("kafka.committed", object({{"group", group}, {"topic", topic}, {"partition", partition}}));
  if (r.is_null()) return std::nullopt;
  return r.as_int();
}

int64_t Kafka::CommittedOffset(const std::string& group, const std::string& topic, int partition) {
  return Committed(group, topic, partition).value_or(-1);
}

std::vector<KafkaOffsets> Kafka::Commits(const std::string& group) {
  std::vector<KafkaOffsets> out;
  const lb::Json reply = lb::call("kafka.commits", group);
  for (const lb::Json& c : reply.items()) out.push_back(offsets_of(c));
  return out;
}

void Kafka::Commit(const std::string& group, const KafkaOffsets& offsets) {
  change("kafka.commit", object({{"group", group}, {"offsets", offsets_json(offsets)}}));
}

void Kafka::OnCommit(std::function<void(const std::string&, const KafkaOffsets&)> fn) {
  lb::call("kafka.onCommit", hook([fn](const lb::Json& args) { fn(args["group"].as_string(), offsets_of(args["offsets"])); }));
}

void Kafka::OnSubscribe(std::function<void(const std::string&, const std::vector<std::string>&)> fn) {
  lb::call("kafka.onSubscribe", hook([fn](const lb::Json& args) { fn(args["group"].as_string(), strings_of(args["topics"])); }));
}

void Kafka::FailNext(const std::string& topic, int times) {
  change("kafka.failNext", object({{"topic", topic}, {"times", times}}));
}

void Kafka::Stall(const std::string& topic) { change("kafka.stall", object({{"topic", topic}, {"seconds", lb::Json()}})); }

void Kafka::StallFor(const std::string& topic, double seconds) {
  change("kafka.stall", object({{"topic", topic}, {"seconds", seconds}}));
}

void Kafka::Resume(const std::string& topic) { change("kafka.resume", topic); }

void Kafka::LoseAcks(const std::string& topic, int times) {
  change("kafka.loseAcks", object({{"topic", topic}, {"times", times}}));
}

int Kafka::Failover(const std::string& topic) { return static_cast<int>(change("kafka.failover", topic).as_int()); }

std::vector<KafkaEvent> Kafka::Events() { return EventsOfKinds({}); }

std::vector<KafkaEvent> Kafka::EventsOfKinds(const std::vector<std::string>& kinds) {
  lb::Json list = lb::Json::array();
  for (const auto& k : kinds) list.push(k);
  std::vector<KafkaEvent> out;
  const lb::Json reply = lb::call("kafka.events", list);
  for (const lb::Json& e : reply.items()) {
    KafkaEvent ev;
    ev.Kind = e["kind"].as_string();
    ev.Group = e["group"].as_string();
    ev.Topic = e["topic"].as_string();
    ev.Partition = static_cast<int>(e["partition"].as_int());
    ev.Offset = e["offset"].as_int();
    ev.Topics = strings_of(e["topics"]);
    ev.Offsets = offsets_of(e["offsets"]);
    ev.Lost = static_cast<int>(e["lost"].as_int());
    ev.Client = e["client"].as_string();
    out.push_back(std::move(ev));
  }
  return out;
}

std::vector<KafkaConsumer> Kafka::Consumers() {
  std::vector<KafkaConsumer> out;
  const lb::Json reply = lb::call("kafka.consumers");
  for (const lb::Json& c : reply.items()) {
    KafkaConsumer info;
    info.Client = c["client"].as_string();
    info.Group = c["group"].as_string();
    info.Topics = strings_of(c["topics"]);
    info.AutoCommit = c["autoCommit"].as_bool();
    info.AutoCommitInterval = c["autoCommitInterval"].as_int();
    if (c["config"].is_object())
      for (const auto& [k, v] : c["config"].fields()) info.Config[k] = v.as_string();
    for (const lb::Json& tp : c["assignment"].items())
      info.Assignment.push_back({tp["topic"].as_string(), static_cast<int>(tp["partition"].as_int())});
    info.Closed = c["closed"].as_bool();
    out.push_back(std::move(info));
  }
  return out;
}

int Kafka::Flushes() { return static_cast<int>(EventsOfKinds({"flush"}).size()); }

}  // namespace harness
