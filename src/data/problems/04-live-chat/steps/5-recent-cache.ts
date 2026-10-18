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
        typescript: {all: [/`recent:\$\{room\}`/, /\.lpush\(\s*key\s*,/]},
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
        typescript: {all: [/\.ltrim\(\s*key\s*,\s*0\s*,\s*(?:RECENT_N\s*-\s*1|49)\s*\)/]},
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
        typescript: {all: [/\.expire\(\s*key\s*,\s*(?:RECENT_TTL_S|3600)\s*\)/]},
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
        typescript: {order: [/\.multi\(/, /\.lpush\(/, /\.ltrim\(/, /\.expire\(/, /\.exec\(\)/]},
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
        typescript: {
          all: [/\.lrange\(\s*key\s*,\s*0\s*,\s*(?:RECENT_N\s*-\s*1|49)\s*\)/, /\.reverse\(\)|\.toReversed\(\)/],
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
    typescript: {
      starter: `import Redis from 'ioredis';
import type {ServerMsg} from 'subscriptions';

const redis = new Redis({host: 'redis', port: 6379});

export const RECENT_N = 50;
export const RECENT_TTL_S = 3600; // a room nobody has spoken in for an hour drops out of Redis

/** Called by the room bus for every delivered message. */
export async function remember(room: string, msg: ServerMsg): Promise<void> {
  const key = ''; // TODO: recent:{room}
  const value = JSON.stringify(msg);
  // TODO: one MULTI: LPUSH key value · LTRIM key 0 RECENT_N-1 · EXPIRE key RECENT_TTL_S · exec
  throw new Error('not implemented');
}

/** The last RECENT_N messages, oldest first: what a joining client sees before live messages flow. */
export async function recent(room: string): Promise<ServerMsg[]> {
  // TODO: LRANGE key 0 RECENT_N-1 is newest first; parse each value and return them reversed
  throw new Error('not implemented');
}
`,
      solution: `import Redis from 'ioredis';
import type {ServerMsg} from 'subscriptions';

const redis = new Redis({host: 'redis', port: 6379});

export const RECENT_N = 50;
export const RECENT_TTL_S = 3600; // a room nobody has spoken in for an hour drops out of Redis

/** Called by the room bus for every delivered message. */
export async function remember(room: string, msg: ServerMsg): Promise<void> {
  const key = \`recent:\${room}\`;
  const value = JSON.stringify(msg);
  await redis.multi().lpush(key, value).ltrim(key, 0, RECENT_N - 1).expire(key, RECENT_TTL_S).exec();
}

/** The last RECENT_N messages, oldest first: what a joining client sees before live messages flow. */
export async function recent(room: string): Promise<ServerMsg[]> {
  const key = \`recent:\${room}\`;
  const newestFirst = await redis.lrange(key, 0, RECENT_N - 1);
  return newestFirst.reverse().map(v => JSON.parse(v) as ServerMsg);
}
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
  harness: {
    python: `from google.protobuf import json_format

import chat_pb2

KEY = "recent:room-7"


def _msg(i, room="room-7"):
    return chat_pb2.ServerMsg(room=room, user="ana" if i % 2 else "bo", text=f"m{i}", ts=1700000000000 + i)


def _stored(ctx):
    """The list as Redis holds it, head first, parsed back into ServerMsgs."""
    return [json_format.Parse(v, chat_pb2.ServerMsg()) for v in ctx.redis.lrange(KEY, 0, -1)]


def check_lpush(ctx):
    m = ctx.load("recent_messages")
    m.remember("room-7", _msg(1))
    m.remember("room-7", _msg(2))
    m.remember("room-8", _msg(3, "room-8"))
    assert ctx.redis.type(KEY) == "list", f"recent:room-7 is {ctx.redis.type(KEY)!r} (keys: {sorted(ctx.redis.keys())}), expected a list"
    stored = _stored(ctx)
    assert [s.text for s in stored] == ["m2", "m1"], f"recent:room-7 holds {[s.text for s in stored]} head first, expected ['m2', 'm1']: LPUSH puts the newest at the head"
    assert stored[1] == _msg(1), f"the stored JSON parses back to {stored[1]!r}, expected {_msg(1)!r}"
    other = [s.text for s in (json_format.Parse(v, chat_pb2.ServerMsg()) for v in ctx.redis.lrange("recent:room-8", 0, -1))]
    assert other == ["m3"], f"recent:room-8 holds {other}, expected ['m3']: one list per room"


def check_trim(ctx):
    m = ctx.load("recent_messages")
    for i in range(1, 56):
        m.remember("room-7", _msg(i))
    n = ctx.redis.llen(KEY)
    assert n == 50, f"after 55 messages recent:room-7 holds {n} entries, expected 50 (LTRIM 0 49 after every push)"
    stored = _stored(ctx)
    assert stored[0].text == "m55" and stored[-1].text == "m6", f"the list runs {stored[0].text} .. {stored[-1].text}, expected m55 .. m6: trimming must drop the oldest, not the newest"


def check_expire(ctx):
    m = ctx.load("recent_messages")
    m.remember("room-7", _msg(1))
    ttl = ctx.redis.ttl(KEY)
    assert 3500 <= ttl <= 3600, f"recent:room-7 has TTL {ttl}, expected 3600 s"
    ctx.clock.advance(1800)
    m.remember("room-7", _msg(2))
    ttl = ctx.redis.ttl(KEY)
    assert 3500 <= ttl <= 3600, f"a new message must restart the hour: TTL is {ttl} after the second remember, expected 3600"
    ctx.clock.advance(3601)
    assert not ctx.redis.exists(KEY), "a room quiet for an hour must drop out of Redis"


def check_pipelined(ctx):
    m = ctx.load("recent_messages")
    pipe_cls = type(ctx.redis.pipeline())
    client_cls = ctx.redis.__class__
    real_execute, real_command = pipe_cls.execute, client_cls.execute_command
    executes, direct = [], []

    def counting_execute(self, *args, **kw):
        executes.append((self.transaction, [c[0][0].upper() for c in self.command_stack]))
        return real_execute(self, *args, **kw)

    def counting_command(self, *args, **kw):
        direct.append(str(args[0]).upper())
        return real_command(self, *args, **kw)

    pipe_cls.execute, client_cls.execute_command = counting_execute, counting_command
    try:
        m.remember("room-7", _msg(1))
    finally:
        pipe_cls.execute, client_cls.execute_command = real_execute, real_command
    assert direct == [], f"remember sent {direct} outside a pipeline: queue LPUSH, LTRIM and EXPIRE in one pipeline and execute once"
    assert len(executes) == 1, f"remember executed {len(executes)} pipeline(s), expected exactly one round trip"
    transaction, commands = executes[0]
    assert commands == ["LPUSH", "LTRIM", "EXPIRE"], f"the pipeline queued {commands}, expected ['LPUSH', 'LTRIM', 'EXPIRE'] in that order"
    assert transaction, "the pipeline must be a MULTI (transaction=True) so no reader ever sees the list at 51"
    stored = _stored(ctx)
    assert [s.text for s in stored] == ["m1"] and 3500 <= ctx.redis.ttl(KEY) <= 3600, "after execute the list must hold the message with its TTL set"


def check_chronological(ctx):
    m = ctx.load("recent_messages")
    assert m.recent("room-7") == [], f"a quiet room must give an empty list, got {m.recent('room-7')!r}"
    for i in range(1, 4):
        m.remember("room-7", _msg(i))
    got = m.recent("room-7")
    assert all(isinstance(s, chat_pb2.ServerMsg) for s in got), f"recent must return ServerMsg objects, got {[type(s).__name__ for s in got]}"
    assert [s.text for s in got] == ["m1", "m2", "m3"], f"recent('room-7') is {[s.text for s in got]}, expected ['m1', 'm2', 'm3'] oldest first"
    assert got[0] == _msg(1), f"recent()[0] is {got[0]!r}, expected {_msg(1)!r}"
    for i in range(4, 61):
        m.remember("room-7", _msg(i))
    got = [s.text for s in m.recent("room-7")]
    assert got == [f"m{i}" for i in range(11, 61)], f"after 60 messages recent('room-7') must be m11 .. m60 oldest first, got {got[:3]} .. {got[-3:]} ({len(got)} entries)"
`,
    typescript: `const KEY = 'recent:room-7';

const msg = (i, room = 'room-7') => ({room, user: i % 2 ? 'ana' : 'bo', text: \`m\${i}\`, ts: 1700000000000 + i});

/** The list as Redis holds it, head first, parsed back into ServerMsgs. */
const stored = (ctx, key = KEY) => ctx.redis.lrange(key, 0, -1).map(v => JSON.parse(v));

export async function check_lpush(ctx) {
  const m = ctx.load('recent_messages');
  await m.remember('room-7', msg(1));
  await m.remember('room-7', msg(2));
  await m.remember('room-8', msg(3, 'room-8'));
  assert.equal(ctx.redis.type(KEY), 'list', \`recent:room-7 is \${JSON.stringify(ctx.redis.type(KEY))} (keys: \${JSON.stringify(ctx.redis.keys('*'))}), expected a list\`);
  const list = stored(ctx);
  assert.deepEqual(list.map(s => s.text), ['m2', 'm1'], \`recent:room-7 holds \${JSON.stringify(list.map(s => s.text))} head first, expected ['m2', 'm1']: LPUSH puts the newest at the head\`);
  assert.deepEqual(list[1], msg(1), \`the stored JSON parses back to \${JSON.stringify(list[1])}, expected \${JSON.stringify(msg(1))}\`);
  const other = stored(ctx, 'recent:room-8').map(s => s.text);
  assert.deepEqual(other, ['m3'], \`recent:room-8 holds \${JSON.stringify(other)}, expected ['m3']: one list per room\`);
}

export async function check_trim(ctx) {
  const m = ctx.load('recent_messages');
  for (let i = 1; i <= 55; i++) await m.remember('room-7', msg(i));
  const n = ctx.redis.llen(KEY);
  assert.equal(n, 50, \`after 55 messages recent:room-7 holds \${n} entries, expected 50 (LTRIM 0 49 after every push)\`);
  const list = stored(ctx);
  assert(list[0].text === 'm55' && list[list.length - 1].text === 'm6', \`the list runs \${list[0].text} .. \${list[list.length - 1].text}, expected m55 .. m6: trimming must drop the oldest, not the newest\`);
}

export async function check_expire(ctx) {
  const m = ctx.load('recent_messages');
  await m.remember('room-7', msg(1));
  let ttl = ctx.redis.ttl(KEY);
  assert(3500 <= ttl && ttl <= 3600, \`recent:room-7 has TTL \${ttl}, expected 3600 s\`);
  ctx.clock.advance(1800);
  await m.remember('room-7', msg(2));
  ttl = ctx.redis.ttl(KEY);
  assert(3500 <= ttl && ttl <= 3600, \`a new message must restart the hour: TTL is \${ttl} after the second remember, expected 3600\`);
  ctx.clock.advance(3601);
  assert.equal(ctx.redis.exists(KEY), 0, 'a room quiet for an hour must drop out of Redis');
}

export async function check_pipelined(ctx) {
  const m = ctx.load('recent_messages');
  const before = ctx.redisRoundTrips().length;
  await m.remember('room-7', msg(1));
  const trips = ctx.redisRoundTrips().slice(before);
  const direct = trips.filter(t => t.length === 1).flat();
  assert.deepEqual(direct, [], \`remember sent \${JSON.stringify(direct)} outside a pipeline: queue LPUSH, LTRIM and EXPIRE in one MULTI and exec once\`);
  assert.equal(trips.length, 1, \`remember made \${trips.length} round trip(s) (\${JSON.stringify(trips)}), expected exactly one\`);
  const [trip] = trips;
  const commands = trip.filter(c => c !== 'MULTI' && c !== 'EXEC');
  assert.deepEqual(commands, ['LPUSH', 'LTRIM', 'EXPIRE'], \`the pipeline queued \${JSON.stringify(commands)}, expected ['LPUSH', 'LTRIM', 'EXPIRE'] in that order\`);
  assert(trip[0] === 'MULTI', 'the pipeline must be a MULTI (redis.multi()) so no reader ever sees the list at 51');
  const list = stored(ctx);
  assert(list.length === 1 && list[0].text === 'm1' && 3500 <= ctx.redis.ttl(KEY) && ctx.redis.ttl(KEY) <= 3600, 'after exec the list must hold the message with its TTL set');
}

export async function check_chronological(ctx) {
  const m = ctx.load('recent_messages');
  assert.deepEqual(await m.recent('room-7'), [], \`a quiet room must give an empty list, got \${JSON.stringify(await m.recent('room-7'))}\`);
  for (let i = 1; i <= 3; i++) await m.remember('room-7', msg(i));
  let got = await m.recent('room-7');
  assert(got.every(s => s !== null && typeof s === 'object' && typeof s.text === 'string'), \`recent must return ServerMsg objects, got \${JSON.stringify(got)}\`);
  assert.deepEqual(got.map(s => s.text), ['m1', 'm2', 'm3'], \`recent('room-7') is \${JSON.stringify(got.map(s => s.text))}, expected ['m1', 'm2', 'm3'] oldest first\`);
  assert.deepEqual(got[0], msg(1), \`recent()[0] is \${JSON.stringify(got[0])}, expected \${JSON.stringify(msg(1))}\`);
  for (let i = 4; i <= 60; i++) await m.remember('room-7', msg(i));
  got = (await m.recent('room-7')).map(s => s.text);
  const want = Array.from({length: 50}, (_, i) => \`m\${i + 11}\`);
  assert.deepEqual(got, want, \`after 60 messages recent('room-7') must be m11 .. m60 oldest first, got \${JSON.stringify(got.slice(0, 3))} .. \${JSON.stringify(got.slice(-3))} (\${got.length} entries)\`);
}
`,
  },
  debrief: `LPUSH + LTRIM + EXPIRE is the Redis idiom for a bounded, self-cleaning recent-items list, and wrapping the three in MULTI/EXEC is what makes it one round trip *and* one atomic unit — a plain pipeline saves the round trips but another client's LRANGE can still slip in between the push and the trim. The list is maintained by the writer, so a miss is not a signal to load anything; it just means the client uses the history endpoint. Real systems store a sequence number with each entry so a reconnecting client can ask for "everything after N", and keep the list per shard when a single room is hot enough to make one Redis key a bottleneck.`,
};
