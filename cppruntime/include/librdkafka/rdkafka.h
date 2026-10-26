/*
 * librdkafka's C API, the subset the courses use, over the runtime's librdkafka model (the C++ API
 * in <librdkafka/rdkafkacpp.h>, implemented in cppruntime/src/kafka.cpp; this layer in
 * cppruntime/src/kafka_c.cpp): configuration, producers (rd_kafka_producev, delivery reports through
 * the dr_msg_cb served by rd_kafka_poll/rd_kafka_flush), consumers (subscribe/assign,
 * rd_kafka_consumer_poll, rd_kafka_commit), topic partition lists.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
#define LB_RDKAFKA_ERR(name, value, text) RD_KAFKA_RESP_ERR_##name = value,
#include <librdkafka/rdkafka_errors.inc>
#undef LB_RDKAFKA_ERR
  RD_KAFKA_RESP_ERR__BEGIN = -200,
  RD_KAFKA_RESP_ERR__END = -100,
  RD_KAFKA_RESP_ERR_NOT_LEADER_OR_FOLLOWER = 6,
  RD_KAFKA_RESP_ERR_GROUP_LOAD_IN_PROGRESS = 14,
  RD_KAFKA_RESP_ERR_GROUP_COORDINATOR_NOT_AVAILABLE = 15,
  RD_KAFKA_RESP_ERR_NOT_COORDINATOR_FOR_GROUP = 16,
} rd_kafka_resp_err_t;

typedef enum rd_kafka_type_t { RD_KAFKA_PRODUCER, RD_KAFKA_CONSUMER } rd_kafka_type_t;

typedef enum { RD_KAFKA_CONF_UNKNOWN = -2, RD_KAFKA_CONF_INVALID = -1, RD_KAFKA_CONF_OK = 0 } rd_kafka_conf_res_t;

typedef struct rd_kafka_s rd_kafka_t;
typedef struct rd_kafka_topic_s rd_kafka_topic_t;
typedef struct rd_kafka_conf_s rd_kafka_conf_t;
typedef struct rd_kafka_topic_conf_s rd_kafka_topic_conf_t;
typedef struct rd_kafka_headers_s rd_kafka_headers_t;

#define RD_KAFKA_PARTITION_UA ((int32_t)-1)
#define RD_KAFKA_OFFSET_BEGINNING -2
#define RD_KAFKA_OFFSET_END -1
#define RD_KAFKA_OFFSET_STORED -1000
#define RD_KAFKA_OFFSET_INVALID -1001
#define RD_KAFKA_OFFSET_TAIL_BASE -2000

#define RD_KAFKA_MSG_F_FREE 0x1
#define RD_KAFKA_MSG_F_COPY 0x2
#define RD_KAFKA_MSG_F_BLOCK 0x4

#define RD_KAFKA_PURGE_F_QUEUE 0x1
#define RD_KAFKA_PURGE_F_INFLIGHT 0x2
#define RD_KAFKA_PURGE_F_NON_BLOCKING 0x4

typedef struct rd_kafka_message_s {
  rd_kafka_resp_err_t err;
  rd_kafka_topic_t* rkt;
  int32_t partition;
  void* payload;
  size_t len;
  void* key;
  size_t key_len;
  int64_t offset;
  void* _private; /* the producer's msg_opaque in a delivery report */
} rd_kafka_message_t;

typedef struct rd_kafka_topic_partition_s {
  char* topic;
  int32_t partition;
  int64_t offset;
  void* metadata;
  size_t metadata_size;
  void* opaque;
  rd_kafka_resp_err_t err;
  void* _private;
} rd_kafka_topic_partition_t;

typedef struct rd_kafka_topic_partition_list_s {
  int cnt;
  int size;
  rd_kafka_topic_partition_t* elems;
} rd_kafka_topic_partition_list_t;

typedef enum rd_kafka_vtype_t {
  RD_KAFKA_VTYPE_END,
  RD_KAFKA_VTYPE_TOPIC,
  RD_KAFKA_VTYPE_RKT,
  RD_KAFKA_VTYPE_PARTITION,
  RD_KAFKA_VTYPE_VALUE,
  RD_KAFKA_VTYPE_KEY,
  RD_KAFKA_VTYPE_OPAQUE,
  RD_KAFKA_VTYPE_MSGFLAGS,
  RD_KAFKA_VTYPE_TIMESTAMP,
  RD_KAFKA_VTYPE_HEADER,
  RD_KAFKA_VTYPE_HEADERS
} rd_kafka_vtype_t;

#define RD_KAFKA_V_END RD_KAFKA_VTYPE_END
#define RD_KAFKA_V_TOPIC(topic) RD_KAFKA_VTYPE_TOPIC, (const char*)(topic)
#define RD_KAFKA_V_RKT(rkt) RD_KAFKA_VTYPE_RKT, (rd_kafka_topic_t*)(rkt)
#define RD_KAFKA_V_PARTITION(partition) RD_KAFKA_VTYPE_PARTITION, (int32_t)(partition)
#define RD_KAFKA_V_VALUE(VALUE, LEN) RD_KAFKA_VTYPE_VALUE, (void*)(VALUE), (size_t)(LEN)
#define RD_KAFKA_V_KEY(KEY, LEN) RD_KAFKA_VTYPE_KEY, (const void*)(KEY), (size_t)(LEN)
#define RD_KAFKA_V_OPAQUE(msg_opaque) RD_KAFKA_VTYPE_OPAQUE, (void*)(msg_opaque)
#define RD_KAFKA_V_MSGFLAGS(msgflags) RD_KAFKA_VTYPE_MSGFLAGS, (int)(msgflags)
#define RD_KAFKA_V_TIMESTAMP(timestamp) RD_KAFKA_VTYPE_TIMESTAMP, (int64_t)(timestamp)
#define RD_KAFKA_V_HEADER(NAME, VALUE, LEN) RD_KAFKA_VTYPE_HEADER, (const char*)(NAME), (const void*)(VALUE), (ssize_t)(LEN)

int rd_kafka_version(void);
const char* rd_kafka_version_str(void);
const char* rd_kafka_err2str(rd_kafka_resp_err_t err);
const char* rd_kafka_err2name(rd_kafka_resp_err_t err);
rd_kafka_resp_err_t rd_kafka_last_error(void);

/* ---- configuration */
rd_kafka_conf_t* rd_kafka_conf_new(void);
void rd_kafka_conf_destroy(rd_kafka_conf_t* conf);
rd_kafka_conf_t* rd_kafka_conf_dup(const rd_kafka_conf_t* conf);
rd_kafka_conf_res_t rd_kafka_conf_set(rd_kafka_conf_t* conf, const char* name, const char* value, char* errstr,
                                      size_t errstr_size);
void rd_kafka_conf_set_dr_msg_cb(rd_kafka_conf_t* conf,
                                 void (*dr_msg_cb)(rd_kafka_t* rk, const rd_kafka_message_t* rkmessage, void* opaque));
void rd_kafka_conf_set_opaque(rd_kafka_conf_t* conf, void* opaque);
void rd_kafka_conf_set_default_topic_conf(rd_kafka_conf_t* conf, rd_kafka_topic_conf_t* tconf);
rd_kafka_topic_conf_t* rd_kafka_topic_conf_new(void);
void rd_kafka_topic_conf_destroy(rd_kafka_topic_conf_t* topic_conf);
rd_kafka_conf_res_t rd_kafka_topic_conf_set(rd_kafka_topic_conf_t* conf, const char* name, const char* value,
                                            char* errstr, size_t errstr_size);

/* ---- clients: rd_kafka_new takes the configuration over (on success) */
rd_kafka_t* rd_kafka_new(rd_kafka_type_t type, rd_kafka_conf_t* conf, char* errstr, size_t errstr_size);
void rd_kafka_destroy(rd_kafka_t* rk);
const char* rd_kafka_name(const rd_kafka_t* rk);
void* rd_kafka_opaque(const rd_kafka_t* rk);
rd_kafka_topic_t* rd_kafka_topic_new(rd_kafka_t* rk, const char* topic, rd_kafka_topic_conf_t* conf);
void rd_kafka_topic_destroy(rd_kafka_topic_t* rkt);
const char* rd_kafka_topic_name(const rd_kafka_topic_t* rkt);
rd_kafka_resp_err_t rd_kafka_query_watermark_offsets(rd_kafka_t* rk, const char* topic, int32_t partition, int64_t* low,
                                                     int64_t* high, int timeout_ms);
rd_kafka_resp_err_t rd_kafka_get_watermark_offsets(rd_kafka_t* rk, const char* topic, int32_t partition, int64_t* low,
                                                   int64_t* high);

/* ---- producing */
rd_kafka_resp_err_t rd_kafka_producev(rd_kafka_t* rk, ...);
int rd_kafka_produce(rd_kafka_topic_t* rkt, int32_t partition, int msgflags, void* payload, size_t len, const void* key,
                     size_t keylen, void* msg_opaque);
int rd_kafka_poll(rd_kafka_t* rk, int timeout_ms);
rd_kafka_resp_err_t rd_kafka_flush(rd_kafka_t* rk, int timeout_ms);
int rd_kafka_outq_len(rd_kafka_t* rk);
rd_kafka_resp_err_t rd_kafka_purge(rd_kafka_t* rk, int purge_flags);

/* ---- consuming */
rd_kafka_resp_err_t rd_kafka_poll_set_consumer(rd_kafka_t* rk);
rd_kafka_resp_err_t rd_kafka_subscribe(rd_kafka_t* rk, const rd_kafka_topic_partition_list_t* topics);
rd_kafka_resp_err_t rd_kafka_unsubscribe(rd_kafka_t* rk);
rd_kafka_resp_err_t rd_kafka_assign(rd_kafka_t* rk, const rd_kafka_topic_partition_list_t* partitions);
/* The next record (rd_kafka_message_destroy it), an error message, or NULL after timeout_ms. */
rd_kafka_message_t* rd_kafka_consumer_poll(rd_kafka_t* rk, int timeout_ms);
rd_kafka_resp_err_t rd_kafka_consumer_close(rd_kafka_t* rk);
/* offsets NULL: the current assignment's stored offsets. */
rd_kafka_resp_err_t rd_kafka_commit(rd_kafka_t* rk, const rd_kafka_topic_partition_list_t* offsets, int async);
rd_kafka_resp_err_t rd_kafka_commit_message(rd_kafka_t* rk, const rd_kafka_message_t* rkmessage, int async);
rd_kafka_resp_err_t rd_kafka_offsets_store(rd_kafka_t* rk, rd_kafka_topic_partition_list_t* offsets);
void rd_kafka_message_destroy(rd_kafka_message_t* rkmessage);
const char* rd_kafka_message_errstr(const rd_kafka_message_t* rkmessage);

/* ---- partition lists */
rd_kafka_topic_partition_list_t* rd_kafka_topic_partition_list_new(int size);
void rd_kafka_topic_partition_list_destroy(rd_kafka_topic_partition_list_t* rkparlist);
rd_kafka_topic_partition_t* rd_kafka_topic_partition_list_add(rd_kafka_topic_partition_list_t* rktparlist,
                                                              const char* topic, int32_t partition);

#ifdef __cplusplus
}
#endif
