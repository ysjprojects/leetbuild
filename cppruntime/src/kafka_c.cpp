// librdkafka's C API (cppruntime/include/librdkafka/rdkafka.h) over the C++ model
// (cppruntime/src/kafka.cpp): an rd_kafka_t wraps an RdKafka::Producer or RdKafka::KafkaConsumer.
#include <librdkafka/rdkafka.h>
#include <librdkafka/rdkafkacpp.h>

#include <cstdarg>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

struct rd_kafka_conf_s {
  std::unique_ptr<RdKafka::Conf> conf{RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL)};
  void (*dr_msg_cb)(rd_kafka_t*, const rd_kafka_message_t*, void*) = nullptr;
  void* opaque = nullptr;
};

struct rd_kafka_topic_conf_s {
  std::unique_ptr<RdKafka::Conf> conf{RdKafka::Conf::create(RdKafka::Conf::CONF_TOPIC)};
};

struct rd_kafka_topic_s {
  rd_kafka_t* rk;
  std::string name;
};

namespace {

// The C delivery report callback, as the C++ model calls its DeliveryReportCb.
struct CReports : RdKafka::DeliveryReportCb {
  rd_kafka_t* rk = nullptr;
  void dr_cb(RdKafka::Message& message) override;
};

// A consumed record handed to C: the C struct first, so rd_kafka_message_destroy finds the rest.
struct CMessage {
  rd_kafka_message_t c{};
  std::unique_ptr<RdKafka::Message> message;
};

thread_local rd_kafka_resp_err_t last_error = RD_KAFKA_RESP_ERR_NO_ERROR;

void copy_errstr(const std::string& text, char* errstr, size_t size) {
  if (errstr == nullptr || size == 0) return;
  std::strncpy(errstr, text.c_str(), size - 1);
  errstr[size - 1] = '\0';
}

}  // namespace

struct rd_kafka_s {
  rd_kafka_type_t type;
  std::string name;
  void* opaque = nullptr;
  void (*dr_msg_cb)(rd_kafka_t*, const rd_kafka_message_t*, void*) = nullptr;
  CReports reports;
  std::unique_ptr<RdKafka::Producer> producer;
  std::unique_ptr<RdKafka::KafkaConsumer> consumer;
  std::map<std::string, std::unique_ptr<rd_kafka_topic_t>> topics;

  // The topic handle a message names (delivery reports and records carry one).
  rd_kafka_topic_t* topic(const std::string& name) {
    auto& slot = topics[name];
    if (!slot) slot.reset(new rd_kafka_topic_t{this, name});
    return slot.get();
  }
  RdKafka::Handle* handle() const {
    return producer ? static_cast<RdKafka::Handle*>(producer.get()) : static_cast<RdKafka::Handle*>(consumer.get());
  }
};

namespace {

void fill(rd_kafka_t* rk, rd_kafka_message_t& c, RdKafka::Message& m) {
  c.err = static_cast<rd_kafka_resp_err_t>(m.err());
  c.rkt = m.topic_name().empty() ? nullptr : rk->topic(m.topic_name());
  c.partition = m.partition();
  c.payload = m.payload();
  c.len = m.len();
  c.key = const_cast<void*>(m.key_pointer());
  c.key_len = m.key_len();
  c.offset = m.offset();
  c._private = m.msg_opaque();
}

void CReports::dr_cb(RdKafka::Message& message) {
  if (rk == nullptr || rk->dr_msg_cb == nullptr) return;
  rd_kafka_message_t c{};
  fill(rk, c, message);
  rk->dr_msg_cb(rk, &c, rk->opaque);
}

std::vector<RdKafka::TopicPartition*> partitions_of(const rd_kafka_topic_partition_list_t* list) {
  std::vector<RdKafka::TopicPartition*> out;
  if (list == nullptr) return out;
  for (int i = 0; i < list->cnt; i++)
    out.push_back(RdKafka::TopicPartition::create(list->elems[i].topic, list->elems[i].partition, list->elems[i].offset));
  return out;
}

}  // namespace

extern "C" {

int rd_kafka_version(void) { return RdKafka::version(); }
const char* rd_kafka_version_str(void) { return "2.6.0"; }

const char* rd_kafka_err2str(rd_kafka_resp_err_t err) {
  switch (static_cast<int>(err)) {
#define LB_RDKAFKA_ERR(name, value, text) \
  case value:                             \
    return text;
#include <librdkafka/rdkafka_errors.inc>
#undef LB_RDKAFKA_ERR
    default:
      return "Unknown error";
  }
}

const char* rd_kafka_err2name(rd_kafka_resp_err_t err) {
  switch (static_cast<int>(err)) {
#define LB_RDKAFKA_ERR(name, value, text) \
  case value:                             \
    return #name;
#include <librdkafka/rdkafka_errors.inc>
#undef LB_RDKAFKA_ERR
    default:
      return "ERR_UNKNOWN";
  }
}

rd_kafka_resp_err_t rd_kafka_last_error(void) { return last_error; }

rd_kafka_conf_t* rd_kafka_conf_new(void) { return new rd_kafka_conf_t(); }
void rd_kafka_conf_destroy(rd_kafka_conf_t* conf) { delete conf; }

rd_kafka_conf_t* rd_kafka_conf_dup(const rd_kafka_conf_t* conf) {
  auto* copy = new rd_kafka_conf_t();
  std::string err;
  for (const auto& [k, v] : conf->conf->properties()) copy->conf->set(k, v, err);
  copy->dr_msg_cb = conf->dr_msg_cb;
  copy->opaque = conf->opaque;
  return copy;
}

rd_kafka_conf_res_t rd_kafka_conf_set(rd_kafka_conf_t* conf, const char* name, const char* value, char* errstr,
                                      size_t errstr_size) {
  std::string err;
  const auto res = conf->conf->set(name, value, err);
  copy_errstr(err, errstr, errstr_size);
  return static_cast<rd_kafka_conf_res_t>(res);
}

void rd_kafka_conf_set_dr_msg_cb(rd_kafka_conf_t* conf, void (*dr_msg_cb)(rd_kafka_t*, const rd_kafka_message_t*, void*)) {
  conf->dr_msg_cb = dr_msg_cb;
}

void rd_kafka_conf_set_opaque(rd_kafka_conf_t* conf, void* opaque) { conf->opaque = opaque; }

void rd_kafka_conf_set_default_topic_conf(rd_kafka_conf_t* conf, rd_kafka_topic_conf_t* tconf) {
  std::string err;
  conf->conf->set("default_topic_conf", tconf->conf.get(), err);
  delete tconf;
}

rd_kafka_topic_conf_t* rd_kafka_topic_conf_new(void) { return new rd_kafka_topic_conf_t(); }
void rd_kafka_topic_conf_destroy(rd_kafka_topic_conf_t* topic_conf) { delete topic_conf; }

rd_kafka_conf_res_t rd_kafka_topic_conf_set(rd_kafka_topic_conf_t* conf, const char* name, const char* value,
                                            char* errstr, size_t errstr_size) {
  std::string err;
  const auto res = conf->conf->set(name, value, err);
  copy_errstr(err, errstr, errstr_size);
  return static_cast<rd_kafka_conf_res_t>(res);
}

rd_kafka_t* rd_kafka_new(rd_kafka_type_t type, rd_kafka_conf_t* conf, char* errstr, size_t errstr_size) {
  std::unique_ptr<rd_kafka_conf_t> owned(conf != nullptr ? conf : rd_kafka_conf_new());
  auto rk = std::make_unique<rd_kafka_t>();
  rk->type = type;
  rk->opaque = owned->opaque;
  rk->dr_msg_cb = owned->dr_msg_cb;
  rk->reports.rk = rk.get();
  std::string err;
  if (type == RD_KAFKA_PRODUCER) {
    if (rk->dr_msg_cb != nullptr) owned->conf->set("dr_cb", static_cast<RdKafka::DeliveryReportCb*>(&rk->reports), err);
    rk->producer.reset(RdKafka::Producer::create(owned->conf.get(), err));
    if (!rk->producer) {
      copy_errstr(err, errstr, errstr_size);
      owned.release();  // on failure the application still owns the configuration
      return nullptr;
    }
    rk->name = rk->producer->name();
  } else {
    rk->consumer.reset(RdKafka::KafkaConsumer::create(owned->conf.get(), err));
    if (!rk->consumer) {
      copy_errstr(err, errstr, errstr_size);
      owned.release();
      return nullptr;
    }
    rk->name = rk->consumer->name();
  }
  return rk.release();
}

void rd_kafka_destroy(rd_kafka_t* rk) { delete rk; }
const char* rd_kafka_name(const rd_kafka_t* rk) { return rk->name.c_str(); }
void* rd_kafka_opaque(const rd_kafka_t* rk) { return rk->opaque; }

rd_kafka_topic_t* rd_kafka_topic_new(rd_kafka_t* rk, const char* topic, rd_kafka_topic_conf_t* conf) {
  delete conf;
  return new rd_kafka_topic_t{rk, topic};
}

void rd_kafka_topic_destroy(rd_kafka_topic_t* rkt) {
  // Handles the client made for messages belong to it; the application's own are deleted.
  for (const auto& [name, owned] : rkt->rk->topics)
    if (owned.get() == rkt) return;
  delete rkt;
}

const char* rd_kafka_topic_name(const rd_kafka_topic_t* rkt) { return rkt->name.c_str(); }

rd_kafka_resp_err_t rd_kafka_query_watermark_offsets(rd_kafka_t* rk, const char* topic, int32_t partition, int64_t* low,
                                                     int64_t* high, int timeout_ms) {
  return static_cast<rd_kafka_resp_err_t>(rk->handle()->query_watermark_offsets(topic, partition, low, high, timeout_ms));
}

rd_kafka_resp_err_t rd_kafka_get_watermark_offsets(rd_kafka_t* rk, const char* topic, int32_t partition, int64_t* low,
                                                   int64_t* high) {
  return static_cast<rd_kafka_resp_err_t>(rk->handle()->get_watermark_offsets(topic, partition, low, high));
}

rd_kafka_resp_err_t rd_kafka_producev(rd_kafka_t* rk, ...) {
  std::string topic;
  int32_t partition = RD_KAFKA_PARTITION_UA;
  const void* value = nullptr;
  size_t len = 0;
  const void* key = nullptr;
  size_t key_len = 0;
  void* opaque = nullptr;
  int flags = 0;
  int64_t timestamp = 0;
  RdKafka::Headers* headers = nullptr;
  va_list ap;
  va_start(ap, rk);
  for (int vtype = va_arg(ap, int); vtype != RD_KAFKA_VTYPE_END; vtype = va_arg(ap, int)) {
    switch (vtype) {
      case RD_KAFKA_VTYPE_TOPIC:
        topic = va_arg(ap, const char*);
        break;
      case RD_KAFKA_VTYPE_RKT:
        topic = va_arg(ap, rd_kafka_topic_t*)->name;
        break;
      case RD_KAFKA_VTYPE_PARTITION:
        partition = va_arg(ap, int32_t);
        break;
      case RD_KAFKA_VTYPE_VALUE:
        value = va_arg(ap, void*);
        len = va_arg(ap, size_t);
        break;
      case RD_KAFKA_VTYPE_KEY:
        key = va_arg(ap, const void*);
        key_len = va_arg(ap, size_t);
        break;
      case RD_KAFKA_VTYPE_OPAQUE:
        opaque = va_arg(ap, void*);
        break;
      case RD_KAFKA_VTYPE_MSGFLAGS:
        flags = va_arg(ap, int);
        break;
      case RD_KAFKA_VTYPE_TIMESTAMP:
        timestamp = va_arg(ap, int64_t);
        break;
      case RD_KAFKA_VTYPE_HEADER: {
        const char* name = va_arg(ap, const char*);
        const void* hvalue = va_arg(ap, const void*);
        const ssize_t hlen = va_arg(ap, ssize_t);
        if (headers == nullptr) headers = RdKafka::Headers::create();
        headers->add(name, hvalue, hlen < 0 ? (hvalue != nullptr ? std::strlen(static_cast<const char*>(hvalue)) : 0)
                                            : static_cast<size_t>(hlen));
        break;
      }
      default:
        va_end(ap);
        delete headers;
        return RD_KAFKA_RESP_ERR__INVALID_ARG;
    }
  }
  va_end(ap);
  if (!rk->producer) {
    delete headers;
    return RD_KAFKA_RESP_ERR__INVALID_ARG;
  }
  const auto err = static_cast<rd_kafka_resp_err_t>(
      rk->producer->produce(topic, partition, flags, value, len, key, key_len, timestamp, headers, opaque));
  if (err != RD_KAFKA_RESP_ERR_NO_ERROR) delete headers;
  return err;
}

int rd_kafka_produce(rd_kafka_topic_t* rkt, int32_t partition, int msgflags, void* payload, size_t len, const void* key,
                     size_t keylen, void* msg_opaque) {
  if (!rkt->rk->producer) return -1;
  last_error = static_cast<rd_kafka_resp_err_t>(
      rkt->rk->producer->produce(rkt->name, partition, msgflags, payload, len, key, keylen, 0, msg_opaque));
  return last_error == RD_KAFKA_RESP_ERR_NO_ERROR ? 0 : -1;
}

int rd_kafka_poll(rd_kafka_t* rk, int timeout_ms) { return rk->handle()->poll(timeout_ms); }

rd_kafka_resp_err_t rd_kafka_flush(rd_kafka_t* rk, int timeout_ms) {
  return rk->producer ? static_cast<rd_kafka_resp_err_t>(rk->producer->flush(timeout_ms)) : RD_KAFKA_RESP_ERR_NO_ERROR;
}

int rd_kafka_outq_len(rd_kafka_t* rk) { return rk->handle()->outq_len(); }

rd_kafka_resp_err_t rd_kafka_purge(rd_kafka_t* rk, int purge_flags) {
  return rk->producer ? static_cast<rd_kafka_resp_err_t>(rk->producer->purge(purge_flags)) : RD_KAFKA_RESP_ERR__INVALID_ARG;
}

rd_kafka_resp_err_t rd_kafka_poll_set_consumer(rd_kafka_t*) { return RD_KAFKA_RESP_ERR_NO_ERROR; }

rd_kafka_resp_err_t rd_kafka_subscribe(rd_kafka_t* rk, const rd_kafka_topic_partition_list_t* topics) {
  if (!rk->consumer || topics == nullptr) return RD_KAFKA_RESP_ERR__INVALID_ARG;
  std::vector<std::string> names;
  for (int i = 0; i < topics->cnt; i++) names.emplace_back(topics->elems[i].topic);
  return static_cast<rd_kafka_resp_err_t>(rk->consumer->subscribe(names));
}

rd_kafka_resp_err_t rd_kafka_unsubscribe(rd_kafka_t* rk) {
  return rk->consumer ? static_cast<rd_kafka_resp_err_t>(rk->consumer->unsubscribe()) : RD_KAFKA_RESP_ERR__INVALID_ARG;
}

rd_kafka_resp_err_t rd_kafka_assign(rd_kafka_t* rk, const rd_kafka_topic_partition_list_t* partitions) {
  if (!rk->consumer) return RD_KAFKA_RESP_ERR__INVALID_ARG;
  if (partitions == nullptr) return static_cast<rd_kafka_resp_err_t>(rk->consumer->unassign());
  auto list = partitions_of(partitions);
  const auto err = rk->consumer->assign(list);
  RdKafka::TopicPartition::destroy(list);
  return static_cast<rd_kafka_resp_err_t>(err);
}

rd_kafka_message_t* rd_kafka_consumer_poll(rd_kafka_t* rk, int timeout_ms) {
  if (!rk->consumer) return nullptr;
  std::unique_ptr<RdKafka::Message> m(rk->consumer->consume(timeout_ms));
  if (m->err() == RdKafka::ERR__TIMED_OUT) return nullptr;
  auto* out = new CMessage();
  out->message = std::move(m);
  fill(rk, out->c, *out->message);
  return &out->c;
}

rd_kafka_resp_err_t rd_kafka_consumer_close(rd_kafka_t* rk) {
  return rk->consumer ? static_cast<rd_kafka_resp_err_t>(rk->consumer->close()) : RD_KAFKA_RESP_ERR__INVALID_ARG;
}

rd_kafka_resp_err_t rd_kafka_commit(rd_kafka_t* rk, const rd_kafka_topic_partition_list_t* offsets, int async) {
  if (!rk->consumer) return RD_KAFKA_RESP_ERR__INVALID_ARG;
  if (offsets == nullptr)
    return static_cast<rd_kafka_resp_err_t>(async ? rk->consumer->commitAsync() : rk->consumer->commitSync());
  auto list = partitions_of(offsets);
  const auto err = async ? rk->consumer->commitAsync(list) : rk->consumer->commitSync(list);
  RdKafka::TopicPartition::destroy(list);
  return static_cast<rd_kafka_resp_err_t>(err);
}

rd_kafka_resp_err_t rd_kafka_commit_message(rd_kafka_t* rk, const rd_kafka_message_t* rkmessage, int async) {
  if (!rk->consumer || rkmessage == nullptr || rkmessage->err != RD_KAFKA_RESP_ERR_NO_ERROR || rkmessage->rkt == nullptr)
    return RD_KAFKA_RESP_ERR__INVALID_ARG;
  std::vector<RdKafka::TopicPartition*> one{
      RdKafka::TopicPartition::create(rkmessage->rkt->name, rkmessage->partition, rkmessage->offset + 1)};
  const auto err = async ? rk->consumer->commitAsync(one) : rk->consumer->commitSync(one);
  RdKafka::TopicPartition::destroy(one);
  return static_cast<rd_kafka_resp_err_t>(err);
}

rd_kafka_resp_err_t rd_kafka_offsets_store(rd_kafka_t* rk, rd_kafka_topic_partition_list_t* offsets) {
  if (!rk->consumer) return RD_KAFKA_RESP_ERR__INVALID_ARG;
  auto list = partitions_of(offsets);
  const auto err = rk->consumer->offsets_store(list);
  RdKafka::TopicPartition::destroy(list);
  return static_cast<rd_kafka_resp_err_t>(err);
}

void rd_kafka_message_destroy(rd_kafka_message_t* rkmessage) { delete reinterpret_cast<CMessage*>(rkmessage); }

const char* rd_kafka_message_errstr(const rd_kafka_message_t* rkmessage) {
  if (rkmessage->err == RD_KAFKA_RESP_ERR_NO_ERROR) return nullptr;
  return rd_kafka_err2str(rkmessage->err);
}

rd_kafka_topic_partition_list_t* rd_kafka_topic_partition_list_new(int size) {
  auto* list = new rd_kafka_topic_partition_list_t();
  list->size = size > 0 ? size : 1;
  list->elems = static_cast<rd_kafka_topic_partition_t*>(std::calloc(static_cast<size_t>(list->size), sizeof(rd_kafka_topic_partition_t)));
  return list;
}

void rd_kafka_topic_partition_list_destroy(rd_kafka_topic_partition_list_t* list) {
  if (list == nullptr) return;
  for (int i = 0; i < list->cnt; i++) std::free(list->elems[i].topic);
  std::free(list->elems);
  delete list;
}

rd_kafka_topic_partition_t* rd_kafka_topic_partition_list_add(rd_kafka_topic_partition_list_t* list, const char* topic,
                                                              int32_t partition) {
  if (list->cnt == list->size) {
    list->size *= 2;
    list->elems = static_cast<rd_kafka_topic_partition_t*>(
        std::realloc(list->elems, static_cast<size_t>(list->size) * sizeof(rd_kafka_topic_partition_t)));
  }
  rd_kafka_topic_partition_t* tp = &list->elems[list->cnt++];
  std::memset(tp, 0, sizeof(*tp));
  tp->topic = strdup(topic);
  tp->partition = partition;
  tp->offset = RD_KAFKA_OFFSET_INVALID;
  return tp;
}

}  // extern "C"
