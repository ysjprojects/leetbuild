import type {Step} from '@/lib/types';

// ---- 5. Recent-messages list in Redis ---------------------------------------------------------
export const recentCacheStep: Step = {
  id: 'recent-cache',
  title: 'Seed joiners from a recent-messages list',
  concept: 'redis',
  file: 'recent_messages',
  focus: ['server-a', 'redis'],
  task: `## Task

A client that joins a room sees an empty screen until someone speaks — unless the server can hand it the
last few messages without a trip to the message store. Keep them in a Redis list:

- \`remember(room, msg)\` is called by the room bus for every delivered message. It runs three commands in
  **one pipeline / MULTI**: \`LPUSH recent:{room} <json>\`, \`LTRIM recent:{room} 0 49\` (keep the newest
  50), \`EXPIRE recent:{room} 3600\` (a room nobody has spoken in for an hour drops out of Redis).
- \`recent(room)\`: \`LRANGE recent:{room} 0 49\` — which is newest first, because LPUSH prepends — and
  return it **reversed**, in chronological order, so the client can render it straight into the timeline
  before live messages start flowing.

:::widget cache-aside {}

> This is a cache the writer maintains (write-through), not cache-aside: nothing is ever loaded into it
> on a miss. A miss simply means "quiet room", and the client falls back to the history endpoint.`,
  sequence: {
    participants: ['room bus', 'Redis', 'chat-server'],
    messages: [
      {
        from: 'room bus',
        to: 'Redis',
        label: 'MULTI · LPUSH recent:room-7 · LTRIM 0 49 · EXPIRE 3600 · EXEC',
        kind: 'sync',
      },
      {from: 'Redis', to: 'room bus', label: '[51, OK, 1]', kind: 'reply'},
      {from: 'chat-server', to: 'Redis', label: 'LRANGE recent:room-7 0 49', kind: 'sync'},
      {from: 'Redis', to: 'chat-server', label: '50 values, newest first', kind: 'reply'},
      {from: 'chat-server', to: 'chat-server', label: 'reverse → oldest first → write to the new stream', kind: 'sync'},
    ],
  },
  hints: [
    'LPUSH then LTRIM is the idiom for a capped list: the push may make it 51 long for an instant, the trim brings it back to 50. Nobody ever sees the 51st because both run inside the same MULTI.',
    'EXPIRE on every write is deliberate: the TTL restarts at each message, so only rooms that go quiet expire. Setting it once at creation would drop busy rooms mid-conversation.',
    'LRANGE 0 49 on a list built with LPUSH gives the newest element first. Reverse it once, in memory, before returning; do not RPUSH instead or the trim would cut the wrong end.',
  ],
  checks: [
    {
      id: 'lpush',
      title: 'Prepends each message to recent:{room}',
      detail: 'The key is `recent:{room}` and every message is `LPUSH`ed so the newest is at the head.',
      match: {
        python: {all: [/f"recent:\{room\}"/, /\.lpush\(\s*key\s*,/]},
        go: {
          all: [/"recent:"\s*\+\s*room|fmt\.Sprintf\(\s*"recent:%s"\s*,\s*room\s*\)/, /\.LPush\(\s*ctx\s*,\s*key\s*,/],
        },
        scala: {all: [/s"recent:\$\{?room\}?"/, /\.lpush\(\s*key\s*,/]},
        cpp: {all: [/"recent:"\s*\+\s*room/, /\.lpush\(\s*key\s*,/]},
      },
    },
    {
      id: 'trim',
      title: 'Keeps only the newest 50',
      detail: '`LTRIM recent:{room} 0 49` after every push bounds the list; without it every room grows forever.',
      match: {
        python: {all: [/\.ltrim\(\s*key\s*,\s*0\s*,\s*(?:RECENT_N\s*-\s*1|49)\s*\)/]},
        go: {all: [/\.LTrim\(\s*ctx\s*,\s*key\s*,\s*0\s*,\s*(?:recentN\s*-\s*1|49)\s*\)/]},
        scala: {all: [/\.ltrim\(\s*key\s*,\s*0\s*,\s*(?:RecentN\s*-\s*1|49L?)\s*\)/]},
        cpp: {all: [/\.ltrim\(\s*key\s*,\s*0\s*,\s*(?:kRecentN\s*-\s*1|49)\s*\)/]},
      },
    },
    {
      id: 'expire',
      title: 'Expires quiet rooms',
      detail:
        '`EXPIRE recent:{room} 3600` on every write: the TTL restarts per message, so only rooms nobody speaks in fall out.',
      match: {
        python: {all: [/\.expire\(\s*key\s*,\s*(?:RECENT_TTL_S|3600)\s*\)/]},
        go: {all: [/\.Expire\(\s*ctx\s*,\s*key\s*,\s*(?:recentTTL|time\.Hour|3600\s*\*\s*time\.Second)\s*\)/]},
        scala: {all: [/\.expire\(\s*key\s*,\s*(?:RecentTtlSeconds|3600L?)\s*\)/]},
        cpp: {
          all: [
            /\.expire\(\s*key\s*,\s*(?:kRecentTtl|std::chrono::(?:seconds|hours)\{?\(?\s*(?:3600|1)\s*[)}]|3600s|1h)\s*\)/,
          ],
        },
      },
    },
    {
      id: 'pipelined',
      title: 'Push, trim and expire travel in one round trip',
      detail:
        'Open a MULTI (`pipeline(transaction=True)` / `TxPipelined` / `multi()` / `transaction()`), queue LPUSH → LTRIM → EXPIRE in that order, then execute once: one round trip, and no reader ever sees the list at 51.',
      match: {
        python: {order: [/\.pipeline\(/, /\.lpush\(/, /\.ltrim\(/, /\.expire\(/, /\.execute\(\)/]},
        go: {order: [/TxPipelined\(|Pipelined\(|TxPipeline\(\)|Pipeline\(\)/, /\.LPush\(/, /\.LTrim\(/, /\.Expire\(/]},
        scala: {
          order: [/\.pipelined\(\)|\.multi\(\)/, /\.lpush\(/, /\.ltrim\(/, /\.expire\(/, /\.sync\(\)|\.exec\(\)/],
        },
        cpp: {order: [/redis\.pipeline\(|redis\.transaction\(/, /\.lpush\(/, /\.ltrim\(/, /\.expire\(/, /\.exec\(\)/]},
      },
    },
    {
      id: 'chronological',
      title: 'recent() returns oldest first',
      detail: '`LRANGE recent:{room} 0 49` is newest first; reverse it so the client renders it as a timeline.',
      match: {
        python: {
          all: [/\.lrange\(\s*key\s*,\s*0\s*,\s*(?:RECENT_N\s*-\s*1|49)\s*\)/, /reversed\(|\[::-1\]|\.reverse\(\)/],
        },
        go: {
          all: [
            /\.LRange\(\s*ctx\s*,\s*key\s*,\s*0\s*,\s*(?:recentN\s*-\s*1|49)\s*\)/,
            /slices\.Reverse\(|for i, j := 0, len\(/,
          ],
        },
        scala: {all: [/\.lrange\(\s*key\s*,\s*0\s*,\s*(?:RecentN\s*-\s*1|49L?)\s*\)/, /\.reverse\b/]},
        cpp: {all: [/\.lrange\(\s*key\s*,\s*0\s*,\s*(?:kRecentN\s*-\s*1|49)\s*,/, /std::reverse\(|rbegin\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from google.protobuf import json_format

import chat_pb2

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RECENT_N = 50
RECENT_TTL_S = 3600  # a room nobody has spoken in for an hour drops out of Redis


def remember(room: str, msg: chat_pb2.ServerMsg) -> None:
    """Called by the room bus for every delivered message."""
    key = ...  # TODO: recent:{room}
    value = json_format.MessageToJson(msg, indent=None)
    # TODO: one pipeline: LPUSH key value · LTRIM key 0 RECENT_N-1 · EXPIRE key RECENT_TTL_S · execute
    raise NotImplementedError


def recent(room: str) -> list[chat_pb2.ServerMsg]:
    """The last RECENT_N messages, oldest first: what a joining client sees before live messages flow."""
    # TODO: LRANGE key 0 RECENT_N-1 is newest first; parse each value and return them reversed
    raise NotImplementedError
`,
      solution: `import redis
from google.protobuf import json_format

import chat_pb2

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RECENT_N = 50
RECENT_TTL_S = 3600  # a room nobody has spoken in for an hour drops out of Redis


def remember(room: str, msg: chat_pb2.ServerMsg) -> None:
    """Called by the room bus for every delivered message."""
    key = f"recent:{room}"
    value = json_format.MessageToJson(msg, indent=None)
    pipe = r.pipeline(transaction=True)
    pipe.lpush(key, value)
    pipe.ltrim(key, 0, RECENT_N - 1)
    pipe.expire(key, RECENT_TTL_S)
    pipe.execute()


def recent(room: str) -> list[chat_pb2.ServerMsg]:
    """The last RECENT_N messages, oldest first: what a joining client sees before live messages flow."""
    key = f"recent:{room}"
    newest_first = r.lrange(key, 0, RECENT_N - 1)
    return [json_format.Parse(v, chat_pb2.ServerMsg()) for v in reversed(newest_first)]
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/encoding/protojson"

	pb "chat/gen/chat"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	recentN   = 50
	recentTTL = time.Hour // a room nobody has spoken in for an hour drops out of Redis
)

// remember is called by the room bus for every delivered message.
func remember(ctx context.Context, room string, msg *pb.ServerMsg) error {
	key := "" // TODO: recent:{room}
	value, err := protojson.Marshal(msg)
	if err != nil {
		return err
	}
	// TODO: one TxPipelined: LPush key value · LTrim key 0 recentN-1 · Expire key recentTTL
	_ = key
	_ = value
	return errors.New("not implemented")
}

// recent returns the last recentN messages oldest first: what a joining client sees before live messages flow.
func recent(ctx context.Context, room string) ([]*pb.ServerMsg, error) {
	// TODO: LRange key 0 recentN-1 is newest first; unmarshal each value and return them reversed
	_ = slices.Reverse[[]*pb.ServerMsg]
	return nil, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"slices"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/encoding/protojson"

	pb "chat/gen/chat"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	recentN   = 50
	recentTTL = time.Hour // a room nobody has spoken in for an hour drops out of Redis
)

// remember is called by the room bus for every delivered message.
func remember(ctx context.Context, room string, msg *pb.ServerMsg) error {
	key := "recent:" + room
	value, err := protojson.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.LPush(ctx, key, value)
		pipe.LTrim(ctx, key, 0, recentN-1)
		pipe.Expire(ctx, key, recentTTL)
		return nil
	})
	return err
}

// recent returns the last recentN messages oldest first: what a joining client sees before live messages flow.
func recent(ctx context.Context, room string) ([]*pb.ServerMsg, error) {
	key := "recent:" + room
	values, err := rdb.LRange(ctx, key, 0, recentN-1).Result()
	if err != nil {
		return nil, err
	}
	out := make([]*pb.ServerMsg, 0, len(values))
	for _, v := range values {
		msg := &pb.ServerMsg{}
		if err := protojson.Unmarshal([]byte(v), msg); err == nil {
			out = append(out, msg)
		}
	}
	slices.Reverse(out) // LRANGE gave newest first
	return out, nil
}
`,
    },
    scala: {
      starter: `import chat.chat.ServerMsg
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scalapb.json4s.JsonFormat

object RecentMessages {
  val jedis = new JedisPooled("redis", 6379)

  val RecentN = 50
  val RecentTtlSeconds = 3600L // a room nobody has spoken in for an hour drops out of Redis

  /** Called by the room bus for every delivered message. */
  def remember(room: String, msg: ServerMsg): Unit = {
    val key: String = ??? // TODO: recent:{room}
    val value = JsonFormat.toJsonString(msg)
    // TODO: one MULTI: lpush key value · ltrim key 0 RecentN-1 · expire key RecentTtlSeconds · exec
  }

  /** The last RecentN messages, oldest first: what a joining client sees before live messages flow. */
  def recent(room: String): Seq[ServerMsg] = {
    // TODO: lrange key 0 RecentN-1 is newest first; parse each value and return them reversed
    Seq.empty
  }
}
`,
      solution: `import chat.chat.ServerMsg
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._
import scalapb.json4s.JsonFormat

object RecentMessages {
  val jedis = new JedisPooled("redis", 6379)

  val RecentN = 50
  val RecentTtlSeconds = 3600L // a room nobody has spoken in for an hour drops out of Redis

  /** Called by the room bus for every delivered message. */
  def remember(room: String, msg: ServerMsg): Unit = {
    val key = s"recent:$room"
    val value = JsonFormat.toJsonString(msg)
    val tx = jedis.multi()
    tx.lpush(key, value)
    tx.ltrim(key, 0, RecentN - 1)
    tx.expire(key, RecentTtlSeconds)
    tx.exec()
  }

  /** The last RecentN messages, oldest first: what a joining client sees before live messages flow. */
  def recent(room: String): Seq[ServerMsg] = {
    val key = s"recent:$room"
    val newestFirst = jedis.lrange(key, 0, RecentN - 1).asScala.toVector
    newestFirst.reverse.map(v => JsonFormat.fromJsonString[ServerMsg](v))
  }
}
`,
    },
    cpp: {
      starter: `#include <google/protobuf/util/json_util.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <vector>

#include "chat.pb.h"

using chat::ServerMsg;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kRecentN = 50;
constexpr std::chrono::seconds kRecentTtl{3600};  // a room nobody has spoken in for an hour drops out of Redis

// Called by the room bus for every delivered message.
void remember(const std::string& room, const ServerMsg& msg) {
  const std::string key = "";  // TODO: recent:{room}
  std::string value;
  google::protobuf::util::MessageToJsonString(msg, &value);
  // TODO: one MULTI: lpush key value · ltrim key 0 kRecentN-1 · expire key kRecentTtl · exec
}

// The last kRecentN messages, oldest first: what a joining client sees before live messages flow.
std::vector<ServerMsg> recent(const std::string& room) {
  // TODO: lrange key 0 kRecentN-1 is newest first; parse each value and return them reversed
  return {};
}
`,
      solution: `#include <google/protobuf/util/json_util.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <vector>

#include "chat.pb.h"

using chat::ServerMsg;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kRecentN = 50;
constexpr std::chrono::seconds kRecentTtl{3600};  // a room nobody has spoken in for an hour drops out of Redis

// Called by the room bus for every delivered message.
void remember(const std::string& room, const ServerMsg& msg) {
  const std::string key = "recent:" + room;
  std::string value;
  google::protobuf::util::MessageToJsonString(msg, &value);
  auto tx = redis.transaction();
  tx.lpush(key, value);
  tx.ltrim(key, 0, kRecentN - 1);
  tx.expire(key, kRecentTtl);
  tx.exec();
}

// The last kRecentN messages, oldest first: what a joining client sees before live messages flow.
std::vector<ServerMsg> recent(const std::string& room) {
  const std::string key = "recent:" + room;
  std::vector<std::string> newest_first;
  redis.lrange(key, 0, kRecentN - 1, std::back_inserter(newest_first));
  std::vector<ServerMsg> out;
  out.reserve(newest_first.size());
  for (auto it = newest_first.rbegin(); it != newest_first.rend(); ++it) {
    ServerMsg msg;
    if (google::protobuf::util::JsonStringToMessage(*it, &msg).ok()) out.push_back(msg);
  }
  return out;
}
`,
    },
  },
  debrief: `LPUSH + LTRIM + EXPIRE is the Redis idiom for a bounded, self-cleaning recent-items list, and wrapping the three in MULTI/EXEC is what makes it one round trip *and* one atomic unit — a plain pipeline saves the round trips but another client's LRANGE can still slip in between the push and the trim. The list is maintained by the writer, so a miss is not a signal to load anything; it just means the client uses the history endpoint. Real systems store a sequence number with each entry so a reconnecting client can ask for "everything after N", and keep the list per shard when a single room is hot enough to make one Redis key a bottleneck.`,
};
