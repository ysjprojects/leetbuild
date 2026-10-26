// hiredis (https://github.com/redis/hiredis), as the LeetBuild C++ runtime models it: the same
// synchronous API (redisConnect, redisCommand with its printf-like format, redisReply,
// freeReplyObject, pipelining with redisAppendCommand/redisGetReply) over the runtime's Redis
// server — the one every language's checks share — instead of a socket. Each command is one round
// trip the harness counts. redis-plus-plus is built on it: its ReplyUPtr holds these replies.
// Implemented in cppruntime/src/hiredis.cpp (libleetbuild.a).
#pragma once

#include <cstdarg>
#include <cstddef>
#include <sys/time.h>

#define HIREDIS_MAJOR 1
#define HIREDIS_MINOR 2
#define HIREDIS_PATCH 0

#define REDIS_ERR -1
#define REDIS_OK 0

#define REDIS_ERR_IO 1
#define REDIS_ERR_OTHER 2
#define REDIS_ERR_EOF 3
#define REDIS_ERR_PROTOCOL 4
#define REDIS_ERR_OOM 5
#define REDIS_ERR_TIMEOUT 6

#define REDIS_REPLY_STRING 1
#define REDIS_REPLY_ARRAY 2
#define REDIS_REPLY_INTEGER 3
#define REDIS_REPLY_NIL 4
#define REDIS_REPLY_STATUS 5
#define REDIS_REPLY_ERROR 6
#define REDIS_REPLY_DOUBLE 7
#define REDIS_REPLY_BOOL 8
#define REDIS_REPLY_MAP 9
#define REDIS_REPLY_SET 10
#define REDIS_REPLY_ATTR 11
#define REDIS_REPLY_PUSH 12
#define REDIS_REPLY_BIGNUM 13
#define REDIS_REPLY_VERB 14

typedef struct redisReply {
  int type;                    // REDIS_REPLY_*
  long long integer;           // REDIS_REPLY_INTEGER
  double dval;                 // REDIS_REPLY_DOUBLE
  size_t len;                  // length of str
  char* str;                   // REDIS_REPLY_STRING, STATUS, ERROR (NUL-terminated)
  char vtype[4];               // REDIS_REPLY_VERB
  size_t elements;             // REDIS_REPLY_ARRAY
  struct redisReply** element; // REDIS_REPLY_ARRAY
} redisReply;

struct redisContextImpl;

typedef struct redisContext {
  int err;           // REDIS_ERR_* when a call failed, else 0
  char errstr[128];  // what failed
  int fd;
  int flags;
  struct redisContextImpl* impl;  // the runtime's: replies queued by redisAppendCommand
} redisContext;

typedef struct redisOptions {
  int type;
  int options;
  const struct timeval* connect_timeout;
  const struct timeval* command_timeout;
  struct {
    const char* ip;
    int port;
    const char* source_addr;
  } tcp;
} redisOptions;

// A connection: always succeeds in process (err stays 0).
redisContext* redisConnect(const char* ip, int port);
redisContext* redisConnectWithTimeout(const char* ip, int port, const struct timeval tv);
redisContext* redisConnectNonBlock(const char* ip, int port);
redisContext* redisConnectUnix(const char* path);
redisContext* redisConnectWithOptions(const redisOptions* options);
int redisReconnect(redisContext* c);
int redisSetTimeout(redisContext* c, const struct timeval tv);
int redisEnableKeepAlive(redisContext* c);
void redisFree(redisContext* c);

// A command, formatted as hiredis does: the format splits into arguments at spaces; %s (a C
// string), %b (pointer and size_t length) and the printf integer and floating conversions each
// fill in part of the argument they appear in, spaces and all. The reply (free it with
// freeReplyObject), REDIS_REPLY_ERROR when Redis answered with an error.
void* redisCommand(redisContext* c, const char* format, ...);
void* redisvCommand(redisContext* c, const char* format, va_list ap);
void* redisCommandArgv(redisContext* c, int argc, const char** argv, const size_t* argvlen);

// Pipelining: commands queue on the context; the first redisGetReply sends them all in one round
// trip, and each call hands out the next reply.
int redisAppendCommand(redisContext* c, const char* format, ...);
int redisvAppendCommand(redisContext* c, const char* format, va_list ap);
int redisAppendCommandArgv(redisContext* c, int argc, const char** argv, const size_t* argvlen);
int redisGetReply(redisContext* c, void** reply);

void freeReplyObject(void* reply);
