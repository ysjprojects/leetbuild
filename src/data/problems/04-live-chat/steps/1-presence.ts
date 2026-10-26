import type {Step} from '@/lib/types';

// ---- 1. Presence in Redis ---------------------------------------------------------------------
export const presenceStep: Step = {
  id: 'presence',
  title: 'Presence: heartbeats with a TTL',
  concept: 'redis',
  file: 'presence',
  focus: ['client-a', 'server-a', 'redis'],
  task: `## Task

"Who is online?" is a liveness question, and Redis answers it with expiring keys. Implement the four
presence functions the chat server calls:

- \`heartbeat(user, server)\`: \`SET presence:{user} <server> EX 30\`. The client heartbeats every 10 s
  over its stream; a crashed connection stops beating and the key disappears within 30 s on its own —
  nobody has to notice the crash.
- \`join_room(room, user)\`: \`SADD room:{room}:members\`.
- \`leave(room, user)\`: \`SREM\` from the room set and \`DEL\` the presence key — an explicit leave
  should show immediately, not after the TTL.
- \`online_members(room)\`: \`SMEMBERS\` the room set, then resolve every \`presence:{user}\` in **one**
  \`MGET\` (or one pipeline). Never one \`GET\` per member: a 500-member room would cost 500 round trips
  every time somebody opens the member list.

:::widget cache-aside {}

> The TTL here is not a cache expiry: nothing is stale, the key *is* the fact. "Key exists" means "seen in
> the last 30 s". Expiry is the crash detector.`,
  sequence: {
    participants: ['Client', 'chat-server', 'Redis'],
    messages: [
      {from: 'Client', to: 'chat-server', label: 'join room-7 as ana', kind: 'sync'},
      {from: 'chat-server', to: 'Redis', label: 'SADD room:room-7:members ana', kind: 'sync'},
      {from: 'Client', to: 'chat-server', label: 'heartbeat (every 10 s)', kind: 'async'},
      {from: 'chat-server', to: 'Redis', label: 'SET presence:ana srv-a EX 30', kind: 'sync'},
      {from: 'chat-server', to: 'Redis', label: 'SMEMBERS room:room-7:members', kind: 'sync'},
      {from: 'Redis', to: 'chat-server', label: '[ana, bo, cy]', kind: 'reply'},
      {from: 'chat-server', to: 'Redis', label: 'MGET presence:ana presence:bo presence:cy', kind: 'sync'},
      {from: 'Redis', to: 'chat-server', label: '[srv-a, nil, srv-b]', kind: 'reply'},
      {from: 'chat-server', to: 'Client', label: 'online: ana, cy (bo is away)', kind: 'reply'},
    ],
  },
  hints: [
    'Every heartbeat is the same SET with the same EX: refreshing a key with a TTL restarts the clock. There is no separate EXPIRE call to make.',
    'Membership and presence are two different keys on purpose: the set says who *belongs* to the room, the presence keys say who is *alive*. Online members is the intersection.',
    'Build the list of `presence:{user}` keys from the set members, MGET them all at once, and zip the answers back onto the members; a nil answer means that member is offline.',
  ],
  checks: [
    {
      id: 'ttl',
      title: 'Heartbeats set presence with a 30 s expiry',
      detail:
        '`presence:{user}` must be written with a 30 s expiry (`SET … EX 30` / `SETEX`) so a crashed client vanishes on its own.',
      match: {
        python: {
          all: [
            /\br\.set\(\s*f"presence:\{user\}"\s*,\s*server\s*,\s*ex\s*=\s*(?:PRESENCE_TTL_S|30)\s*\)|\br\.setex\(\s*f"presence:\{user\}"\s*,\s*(?:PRESENCE_TTL_S|30)\s*,\s*server\s*\)/,
          ],
        },
        typescript: {
          all: [
            /\bredis\.set\(\s*`presence:\$\{user\}`\s*,\s*server\s*,\s*['"]EX['"]\s*,\s*(?:PRESENCE_TTL_S|30)\s*\)|\bredis\.setex\(\s*`presence:\$\{user\}`\s*,\s*(?:PRESENCE_TTL_S|30)\s*,\s*server\s*\)/,
          ],
        },
        go: {
          all: [
            /rdb\.Set\(\s*ctx\s*,\s*(?:"presence:"\s*\+\s*user|fmt\.Sprintf\(\s*"presence:%s"\s*,\s*user\s*\))\s*,\s*server\s*,\s*(?:presenceTTL|30\s*\*\s*time\.Second)\s*\)/,
          ],
        },
        scala: {
          all: [
            /jedis\.setex\(\s*s"presence:\$\{?user\}?"\s*,\s*(?:PresenceTtlSeconds|30L?)\s*,\s*server\s*\)|jedis\.set\(\s*s"presence:\$\{?user\}?"\s*,\s*server\s*,\s*SetParams[^\n]*\.ex\(\s*(?:PresenceTtlSeconds|30L?)\s*\)/,
          ],
        },
        cpp: {
          all: [
            /redis\.set\(\s*"presence:"\s*\+\s*user\s*,\s*server\s*,\s*(?:kPresenceTtl|std::chrono::seconds\{?\(?\s*30\s*[)}]|30s)\s*\)|redis\.setex\(\s*"presence:"\s*\+\s*user\s*,\s*(?:kPresenceTtl|std::chrono::seconds\{?\(?\s*30\s*[)}]|30s?)\s*,\s*server\s*\)/,
          ],
        },
      },
    },
    {
      id: 'membership',
      title: 'Join adds to the room set, leave removes',
      detail: '`room:{room}:members` is a Redis set: `SADD` on join, `SREM` on leave.',
      match: {
        python: {
          all: [
            /\br\.sadd\(\s*f"room:\{room\}:members"\s*,\s*user\s*\)/,
            /\br\.srem\(\s*f"room:\{room\}:members"\s*,\s*user\s*\)/,
          ],
        },
        typescript: {
          all: [
            /\bredis\.sadd\(\s*`room:\$\{room\}:members`\s*,\s*user\s*\)/,
            /\bredis\.srem\(\s*`room:\$\{room\}:members`\s*,\s*user\s*\)/,
          ],
        },
        go: {
          all: [
            /rdb\.SAdd\(\s*ctx\s*,\s*(?:"room:"\s*\+\s*room\s*\+\s*":members"|fmt\.Sprintf\(\s*"room:%s:members"\s*,\s*room\s*\))\s*,\s*user\s*\)/,
            /rdb\.SRem\(\s*ctx\s*,\s*(?:"room:"\s*\+\s*room\s*\+\s*":members"|fmt\.Sprintf\(\s*"room:%s:members"\s*,\s*room\s*\))\s*,\s*user\s*\)/,
          ],
        },
        scala: {
          all: [
            /jedis\.sadd\(\s*s"room:\$\{?room\}?:members"\s*,\s*user\s*\)/,
            /jedis\.srem\(\s*s"room:\$\{?room\}?:members"\s*,\s*user\s*\)/,
          ],
        },
        cpp: {
          all: [
            /redis\.sadd\(\s*"room:"\s*\+\s*room\s*\+\s*":members"\s*,\s*user\s*\)/,
            /redis\.srem\(\s*"room:"\s*\+\s*room\s*\+\s*":members"\s*,\s*user\s*\)/,
          ],
        },
      },
    },
    {
      id: 'leave-clears',
      title: 'An explicit leave deletes the presence key',
      detail: 'After `SREM`, `DEL presence:{user}` so the user drops offline now instead of after the TTL.',
      match: {
        python: {order: [/\br\.srem\(/, /\br\.delete\(\s*f"presence:\{user\}"\s*\)/]},
        typescript: {order: [/\bredis\.srem\(/, /\bredis\.del\(\s*`presence:\$\{user\}`\s*\)/]},
        go: {
          order: [
            /rdb\.SRem\(/,
            /rdb\.Del\(\s*ctx\s*,\s*(?:"presence:"\s*\+\s*user|fmt\.Sprintf\(\s*"presence:%s"\s*,\s*user\s*\))\s*\)/,
          ],
        },
        scala: {order: [/jedis\.srem\(/, /jedis\.del\(\s*s"presence:\$\{?user\}?"\s*\)/]},
        cpp: {order: [/redis\.srem\(/, /redis\.del\(\s*"presence:"\s*\+\s*user\s*\)/]},
      },
    },
    {
      id: 'batched',
      title: 'Resolves presence in one round trip',
      detail: '`SMEMBERS` then one `MGET` (or pipeline) of every `presence:{user}` — never a `GET` per member.',
      match: {
        python: {
          all: [/\br\.smembers\(/, /\br\.mget\(|\.pipeline\(/],
          none: [/def online_members(?:(?!\ndef )[\s\S])*?\br\.get\(/],
        },
        typescript: {
          all: [/\bredis\.smembers\(/, /\bredis\.mget\(|\.pipeline\(|\.multi\(/],
          none: [/function onlineMembers(?:(?!\n\})[\s\S])*?\bredis\.get\(/],
        },
        go: {
          all: [/rdb\.SMembers\(/, /rdb\.MGet\(|Pipelined\(|Pipeline\(\)/],
          none: [/func onlineMembers(?:(?!\n\})[\s\S])*?rdb\.Get\(/],
        },
        scala: {
          all: [/jedis\.smembers\(/, /jedis\.mget\(|\.pipelined\(\)/],
          none: [/def onlineMembers(?:(?!\n {2}def )[\s\S])*?jedis\.get\(/],
        },
        cpp: {
          all: [/redis\.smembers\(/, /redis\.mget\(|redis\.pipeline\(/],
          none: [/online_members\((?:(?!\n\})[\s\S])*?redis\.get\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PRESENCE_TTL_S = 30  # clients heartbeat every 10 s: three missed beats and the user is gone


def heartbeat(user: str, server: str) -> None:
    """Called every 10 s while the client's stream is open on \`server\`."""
    # TODO: SET presence:{user} = server with a PRESENCE_TTL_S expiry
    raise NotImplementedError


def join_room(room: str, user: str) -> None:
    # TODO: SADD room:{room}:members
    raise NotImplementedError


def leave(room: str, user: str) -> None:
    # TODO: SREM from the room set, then DEL the presence key
    raise NotImplementedError


def online_members(room: str) -> dict[str, str]:
    """Members whose presence key is alive, mapped to the server holding their stream."""
    # TODO: SMEMBERS, then one MGET of every presence:{user} — not one GET per member
    raise NotImplementedError
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PRESENCE_TTL_S = 30  # clients heartbeat every 10 s: three missed beats and the user is gone


def heartbeat(user: str, server: str) -> None:
    """Called every 10 s while the client's stream is open on \`server\`."""
    r.set(f"presence:{user}", server, ex=PRESENCE_TTL_S)


def join_room(room: str, user: str) -> None:
    r.sadd(f"room:{room}:members", user)


def leave(room: str, user: str) -> None:
    r.srem(f"room:{room}:members", user)
    r.delete(f"presence:{user}")


def online_members(room: str) -> dict[str, str]:
    """Members whose presence key is alive, mapped to the server holding their stream."""
    members = sorted(r.smembers(f"room:{room}:members"))
    if not members:
        return {}
    servers = r.mget([f"presence:{u}" for u in members])
    return {u: s for u, s in zip(members, servers) if s is not None}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const PRESENCE_TTL_S = 30; // clients heartbeat every 10 s: three missed beats and the user is gone

/** Called every 10 s while the client's stream is open on \`server\`. */
export async function heartbeat(user: string, server: string): Promise<void> {
  // TODO: SET presence:{user} = server with a PRESENCE_TTL_S expiry
  throw new Error('not implemented');
}

export async function joinRoom(room: string, user: string): Promise<void> {
  // TODO: SADD room:{room}:members
  throw new Error('not implemented');
}

export async function leave(room: string, user: string): Promise<void> {
  // TODO: SREM from the room set, then DEL the presence key
  throw new Error('not implemented');
}

/** Members whose presence key is alive, mapped to the server holding their stream. */
export async function onlineMembers(room: string): Promise<Record<string, string>> {
  // TODO: SMEMBERS, then one MGET of every presence:{user} — not one GET per member
  throw new Error('not implemented');
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const PRESENCE_TTL_S = 30; // clients heartbeat every 10 s: three missed beats and the user is gone

/** Called every 10 s while the client's stream is open on \`server\`. */
export async function heartbeat(user: string, server: string): Promise<void> {
  await redis.set(\`presence:\${user}\`, server, 'EX', PRESENCE_TTL_S);
}

export async function joinRoom(room: string, user: string): Promise<void> {
  await redis.sadd(\`room:\${room}:members\`, user);
}

export async function leave(room: string, user: string): Promise<void> {
  await redis.srem(\`room:\${room}:members\`, user);
  await redis.del(\`presence:\${user}\`);
}

/** Members whose presence key is alive, mapped to the server holding their stream. */
export async function onlineMembers(room: string): Promise<Record<string, string>> {
  const members = (await redis.smembers(\`room:\${room}:members\`)).sort();
  if (members.length === 0) return {};
  const servers = await redis.mget(members.map(u => \`presence:\${u}\`));
  const online: Record<string, string> = {};
  members.forEach((u, i) => {
    const s = servers[i];
    if (s !== null) online[u] = s;
  });
  return online;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Clients heartbeat every 10 s: three missed beats and the user is gone.
const presenceTTL = 30 * time.Second

// heartbeat is called every 10 s while the client's stream is open on server.
func heartbeat(ctx context.Context, user, server string) error {
	// TODO: SET presence:{user} = server with a presenceTTL expiry
	return errors.New("not implemented")
}

func joinRoom(ctx context.Context, room, user string) error {
	// TODO: SADD room:{room}:members
	return errors.New("not implemented")
}

func leave(ctx context.Context, room, user string) error {
	// TODO: SREM from the room set, then DEL the presence key
	return errors.New("not implemented")
}

// onlineMembers maps every member whose presence key is alive to the server holding their stream.
func onlineMembers(ctx context.Context, room string) (map[string]string, error) {
	// TODO: SMEMBERS, then one MGET of every presence:{user} — not one GET per member
	return nil, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Clients heartbeat every 10 s: three missed beats and the user is gone.
const presenceTTL = 30 * time.Second

// heartbeat is called every 10 s while the client's stream is open on server.
func heartbeat(ctx context.Context, user, server string) error {
	return rdb.Set(ctx, "presence:"+user, server, presenceTTL).Err()
}

func joinRoom(ctx context.Context, room, user string) error {
	return rdb.SAdd(ctx, "room:"+room+":members", user).Err()
}

func leave(ctx context.Context, room, user string) error {
	if err := rdb.SRem(ctx, "room:"+room+":members", user).Err(); err != nil {
		return err
	}
	return rdb.Del(ctx, "presence:"+user).Err()
}

// onlineMembers maps every member whose presence key is alive to the server holding their stream.
func onlineMembers(ctx context.Context, room string) (map[string]string, error) {
	members, err := rdb.SMembers(ctx, "room:"+room+":members").Result()
	if err != nil || len(members) == 0 {
		return nil, err
	}
	keys := make([]string, len(members))
	for i, u := range members {
		keys[i] = "presence:" + u
	}
	servers, err := rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	online := make(map[string]string, len(members))
	for i, s := range servers {
		if server, ok := s.(string); ok { // nil interface = expired or never set
			online[members[i]] = server
		}
	}
	return online, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

object Presence {
  val jedis = new JedisPooled("redis", 6379)

  /** Clients heartbeat every 10 s: three missed beats and the user is gone. */
  val PresenceTtlSeconds = 30L

  /** Called every 10 s while the client's stream is open on \`server\`. */
  def heartbeat(user: String, server: String): Unit = {
    // TODO: SETEX presence:{user} PresenceTtlSeconds server
  }

  def joinRoom(room: String, user: String): Unit = {
    // TODO: SADD room:{room}:members
  }

  def leave(room: String, user: String): Unit = {
    // TODO: SREM from the room set, then DEL the presence key
  }

  /** Members whose presence key is alive, mapped to the server holding their stream. */
  def onlineMembers(room: String): Map[String, String] = {
    // TODO: SMEMBERS, then one MGET of every presence:{user} — not one GET per member
    Map.empty
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

object Presence {
  val jedis = new JedisPooled("redis", 6379)

  /** Clients heartbeat every 10 s: three missed beats and the user is gone. */
  val PresenceTtlSeconds = 30L

  /** Called every 10 s while the client's stream is open on \`server\`. */
  def heartbeat(user: String, server: String): Unit =
    jedis.setex(s"presence:$user", PresenceTtlSeconds, server)

  def joinRoom(room: String, user: String): Unit =
    jedis.sadd(s"room:$room:members", user)

  def leave(room: String, user: String): Unit = {
    jedis.srem(s"room:$room:members", user)
    jedis.del(s"presence:$user")
  }

  /** Members whose presence key is alive, mapped to the server holding their stream. */
  def onlineMembers(room: String): Map[String, String] = {
    val members = jedis.smembers(s"room:$room:members").asScala.toVector.sorted
    if (members.isEmpty) Map.empty
    else {
      val servers = jedis.mget(members.map(u => s"presence:$u"): _*).asScala
      members.zip(servers).collect { case (u, server) if server != null => u -> server }.toMap
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// Clients heartbeat every 10 s: three missed beats and the user is gone.
constexpr std::chrono::seconds kPresenceTtl{30};

// Called every 10 s while the client's stream is open on \`server\`.
void heartbeat(const std::string& user, const std::string& server) {
  // TODO: SET presence:{user} = server with a kPresenceTtl expiry
}

void join_room(const std::string& room, const std::string& user) {
  // TODO: SADD room:{room}:members
}

void leave(const std::string& room, const std::string& user) {
  // TODO: SREM from the room set, then DEL the presence key
}

// Members whose presence key is alive, mapped to the server holding their stream.
std::map<std::string, std::string> online_members(const std::string& room) {
  // TODO: SMEMBERS, then one MGET of every presence:{user} — not one GET per member
  return {};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// Clients heartbeat every 10 s: three missed beats and the user is gone.
constexpr std::chrono::seconds kPresenceTtl{30};

// Called every 10 s while the client's stream is open on \`server\`.
void heartbeat(const std::string& user, const std::string& server) {
  redis.set("presence:" + user, server, kPresenceTtl);
}

void join_room(const std::string& room, const std::string& user) {
  redis.sadd("room:" + room + ":members", user);
}

void leave(const std::string& room, const std::string& user) {
  redis.srem("room:" + room + ":members", user);
  redis.del("presence:" + user);
}

// Members whose presence key is alive, mapped to the server holding their stream.
std::map<std::string, std::string> online_members(const std::string& room) {
  std::vector<std::string> members;
  redis.smembers("room:" + room + ":members", std::back_inserter(members));
  std::map<std::string, std::string> online;
  if (members.empty()) return online;
  std::vector<std::string> keys;
  keys.reserve(members.size());
  for (const auto& u : members) keys.push_back("presence:" + u);
  std::vector<std::optional<std::string>> servers;
  redis.mget(keys.begin(), keys.end(), std::back_inserter(servers));
  for (size_t i = 0; i < members.size(); ++i)
    if (servers[i]) online[members[i]] = *servers[i];  // nullopt = expired or never set
  return online;
}
`,
    },
  },
  harness: {
    python: `def check_ttl(ctx):
    m = ctx.load("presence")
    m.heartbeat("ana", "srv-a")
    assert ctx.redis.get("presence:ana") == "srv-a", f"presence:ana is {ctx.redis.get('presence:ana')!r}, expected 'srv-a'"
    ttl = ctx.redis.ttl("presence:ana")
    assert 25 <= ttl <= 30, f"presence:ana has TTL {ttl}, expected 30 s"
    ctx.clock.advance(20)
    m.heartbeat("ana", "srv-a")
    ttl = ctx.redis.ttl("presence:ana")
    assert 25 <= ttl <= 30, f"a heartbeat must restart the 30 s lease; TTL after the second beat is {ttl}"
    ctx.clock.advance(31)
    assert ctx.redis.get("presence:ana") is None, "a user who stopped heartbeating must vanish after 30 s"


def check_membership(ctx):
    m = ctx.load("presence")
    m.join_room("room-7", "ana")
    m.join_room("room-7", "bo")
    m.join_room("room-7", "ana")
    members = ctx.redis.smembers("room:room-7:members")
    assert members == {"ana", "bo"}, f"room:room-7:members is {sorted(members)}, expected ['ana', 'bo'] (a set: joining twice adds once)"
    m.leave("room-7", "ana")
    members = ctx.redis.smembers("room:room-7:members")
    assert members == {"bo"}, f"after ana leaves, room:room-7:members is {sorted(members)}, expected ['bo']"


def check_leave_clears(ctx):
    m = ctx.load("presence")
    m.join_room("room-7", "ana")
    m.heartbeat("ana", "srv-a")
    m.leave("room-7", "ana")
    assert ctx.redis.get("presence:ana") is None, "an explicit leave must DEL presence:{user} instead of waiting for the TTL"
    assert not ctx.redis.sismember("room:room-7:members", "ana"), "leave must SREM the user from the room set"


def check_batched(ctx):
    m = ctx.load("presence")
    assert m.online_members("empty-room") == {}, "a room with no members has nobody online"
    for user in ("ana", "bo", "cy"):
        m.join_room("room-7", user)
    m.heartbeat("ana", "srv-a")
    m.heartbeat("cy", "srv-b")
    m.heartbeat("dee", "srv-b")  # alive but not a member of room-7
    online = m.online_members("room-7")
    assert online == {"ana": "srv-a", "cy": "srv-b"}, f"online_members('room-7') is {online!r}, expected {{'ana': 'srv-a', 'cy': 'srv-b'}} (bo never heartbeat)"
    ctx.clock.advance(31)
    m.heartbeat("ana", "srv-a")
    online = m.online_members("room-7")
    assert online == {"ana": "srv-a"}, f"after cy's lease expired online_members('room-7') is {online!r}, expected {{'ana': 'srv-a'}}"
    # Round trips: one SMEMBERS plus one MGET (or one pipeline), never a GET per member. Every client
    # in the runtime shares ctx.redis's class, so patching it sees whatever client the learner uses.
    calls = []
    cls = ctx.redis.__class__
    real = cls.execute_command

    def counting(self, *args, **kw):
        calls.append(str(args[0]).upper())
        return real(self, *args, **kw)

    cls.execute_command = counting
    try:
        m.online_members("room-7")
    finally:
        cls.execute_command = real
    assert "GET" not in calls, f"online_members issued {calls}: resolve every presence key in one MGET or one pipeline, not a GET per member"
    assert "MGET" in calls or len(calls) <= 2, f"online_members issued {calls}: expected SMEMBERS then one MGET (or one pipeline)"
`,
    typescript: `export async function check_ttl(ctx) {
  const m = ctx.load('presence');
  await m.heartbeat('ana', 'srv-a');
  assert.equal(ctx.redis.get('presence:ana'), 'srv-a', \`presence:ana is \${JSON.stringify(ctx.redis.get('presence:ana'))}, expected 'srv-a'\`);
  let ttl = ctx.redis.ttl('presence:ana');
  assert(25 <= ttl && ttl <= 30, \`presence:ana has TTL \${ttl}, expected 30 s\`);
  ctx.clock.advance(20);
  await m.heartbeat('ana', 'srv-a');
  ttl = ctx.redis.ttl('presence:ana');
  assert(25 <= ttl && ttl <= 30, \`a heartbeat must restart the 30 s lease; TTL after the second beat is \${ttl}\`);
  ctx.clock.advance(31);
  assert.equal(ctx.redis.get('presence:ana'), null, 'a user who stopped heartbeating must vanish after 30 s');
}

export async function check_membership(ctx) {
  const m = ctx.load('presence');
  await m.joinRoom('room-7', 'ana');
  await m.joinRoom('room-7', 'bo');
  await m.joinRoom('room-7', 'ana');
  let members = [...ctx.redis.smembers('room:room-7:members')].sort();
  assert.deepEqual(members, ['ana', 'bo'], \`room:room-7:members is \${JSON.stringify(members)}, expected ['ana', 'bo'] (a set: joining twice adds once)\`);
  await m.leave('room-7', 'ana');
  members = [...ctx.redis.smembers('room:room-7:members')].sort();
  assert.deepEqual(members, ['bo'], \`after ana leaves, room:room-7:members is \${JSON.stringify(members)}, expected ['bo']\`);
}

export async function check_leave_clears(ctx) {
  const m = ctx.load('presence');
  await m.joinRoom('room-7', 'ana');
  await m.heartbeat('ana', 'srv-a');
  await m.leave('room-7', 'ana');
  assert.equal(ctx.redis.get('presence:ana'), null, 'an explicit leave must DEL presence:{user} instead of waiting for the TTL');
  assert.equal(ctx.redis.sismember('room:room-7:members', 'ana'), 0, 'leave must SREM the user from the room set');
}

export async function check_batched(ctx) {
  const m = ctx.load('presence');
  assert.deepEqual(await m.onlineMembers('empty-room'), {}, 'a room with no members has nobody online');
  for (const user of ['ana', 'bo', 'cy']) await m.joinRoom('room-7', user);
  await m.heartbeat('ana', 'srv-a');
  await m.heartbeat('cy', 'srv-b');
  await m.heartbeat('dee', 'srv-b'); // alive but not a member of room-7
  let online = await m.onlineMembers('room-7');
  assert.deepEqual(online, {ana: 'srv-a', cy: 'srv-b'}, \`onlineMembers('room-7') is \${JSON.stringify(online)}, expected {ana: 'srv-a', cy: 'srv-b'} (bo never heartbeat)\`);
  ctx.clock.advance(31);
  await m.heartbeat('ana', 'srv-a');
  online = await m.onlineMembers('room-7');
  assert.deepEqual(online, {ana: 'srv-a'}, \`after cy's lease expired onlineMembers('room-7') is \${JSON.stringify(online)}, expected {ana: 'srv-a'}\`);
  // Round trips: one SMEMBERS plus one MGET (or one pipeline), never a GET per member.
  const before = ctx.redisRoundTrips().length;
  await m.onlineMembers('room-7');
  const trips = ctx.redisRoundTrips().slice(before);
  const calls = trips.flat();
  assert(!calls.includes('GET'), \`onlineMembers issued \${JSON.stringify(trips)}: resolve every presence key in one MGET or one pipeline, not a GET per member\`);
  assert(calls.includes('MGET') || trips.length <= 2, \`onlineMembers issued \${JSON.stringify(trips)}: expected SMEMBERS then one MGET (or one pipeline)\`);
}
`,
    go: `package main

import (
	"context"
	"slices"

	"leetbuild/harness"
)

var presenceBg = context.Background()

func beatAs(ctx *harness.Ctx, user, server string) {
	ctx.NoError(heartbeat(presenceBg, user, server), "heartbeat(ctx, %q, %q) returned an error", user, server)
}

func joinAs(ctx *harness.Ctx, room, user string) {
	ctx.NoError(joinRoom(presenceBg, room, user), "joinRoom(ctx, %q, %q) returned an error", room, user)
}

func leaveAs(ctx *harness.Ctx, room, user string) {
	ctx.NoError(leave(presenceBg, room, user), "leave(ctx, %q, %q) returned an error", room, user)
}

func onlineIn(ctx *harness.Ctx, room string) map[string]string {
	online, err := onlineMembers(presenceBg, room)
	ctx.NoError(err, "onlineMembers(ctx, %q) returned an error", room)
	return online
}

// presenceOf is presence:{user} as Redis holds it, nil when the key does not exist.
func presenceOf(ctx *harness.Ctx, user string) any {
	if v, ok := ctx.Redis.Get("presence:" + user); ok {
		return v
	}
	return nil
}

func CheckTtl(ctx *harness.Ctx) {
	beatAs(ctx, "ana", "srv-a")
	ctx.Equal(presenceOf(ctx, "ana"), "srv-a", "presence:ana")
	ttl := ctx.Redis.TTL("presence:ana")
	ctx.Assert(25 <= ttl && ttl <= 30, "presence:ana has TTL %d, expected 30 s", ttl)
	ctx.Clock.Advance(20)
	beatAs(ctx, "ana", "srv-a")
	ttl = ctx.Redis.TTL("presence:ana")
	ctx.Assert(25 <= ttl && ttl <= 30, "a heartbeat must restart the 30 s lease; TTL after the second beat is %d", ttl)
	ctx.Clock.Advance(31)
	ctx.Equal(presenceOf(ctx, "ana"), nil, "a user who stopped heartbeating must vanish after 30 s: presence:ana")
}

func CheckMembership(ctx *harness.Ctx) {
	joinAs(ctx, "room-7", "ana")
	joinAs(ctx, "room-7", "bo")
	joinAs(ctx, "room-7", "ana")
	ctx.Equal(ctx.Redis.SMembers("room:room-7:members"), []string{"ana", "bo"}, "room:room-7:members (a set: joining twice adds once)")
	leaveAs(ctx, "room-7", "ana")
	ctx.Equal(ctx.Redis.SMembers("room:room-7:members"), []string{"bo"}, "after ana leaves, room:room-7:members")
}

func CheckLeaveClears(ctx *harness.Ctx) {
	joinAs(ctx, "room-7", "ana")
	beatAs(ctx, "ana", "srv-a")
	leaveAs(ctx, "room-7", "ana")
	ctx.Equal(presenceOf(ctx, "ana"), nil, "an explicit leave must DEL presence:{user} instead of waiting for the TTL: presence:ana")
	ctx.Assert(!ctx.Redis.SIsMember("room:room-7:members", "ana"), "leave must SREM the user from the room set")
}

func CheckBatched(ctx *harness.Ctx) {
	online := onlineIn(ctx, "empty-room")
	ctx.Assert(len(online) == 0, "a room with no members has nobody online: onlineMembers(ctx, %q) is %v", "empty-room", online)
	for _, user := range []string{"ana", "bo", "cy"} {
		joinAs(ctx, "room-7", user)
	}
	beatAs(ctx, "ana", "srv-a")
	beatAs(ctx, "cy", "srv-b")
	beatAs(ctx, "dee", "srv-b") // alive but not a member of room-7
	online = onlineIn(ctx, "room-7")
	ctx.Equal(online, map[string]string{"ana": "srv-a", "cy": "srv-b"}, "onlineMembers(ctx, %q) (bo never heartbeat)", "room-7")
	ctx.Clock.Advance(31)
	beatAs(ctx, "ana", "srv-a")
	online = onlineIn(ctx, "room-7")
	ctx.Equal(online, map[string]string{"ana": "srv-a"}, "after cy's lease expired onlineMembers(ctx, %q)", "room-7")
	// Round trips: one SMEMBERS plus one MGET (or one pipeline), never a GET per member.
	before := len(ctx.Redis.RoundTrips())
	onlineIn(ctx, "room-7")
	trips := ctx.Redis.RoundTrips()[before:]
	var calls []string
	for _, trip := range trips {
		calls = append(calls, trip...)
	}
	ctx.Assert(!slices.Contains(calls, "GET"), "onlineMembers issued %v: resolve every presence key in one MGET or one pipeline, not a GET per member", trips)
	ctx.Assert(slices.Contains(calls, "MGET") || len(trips) <= 2, "onlineMembers issued %v: expected SMEMBERS then one MGET (or one pipeline)", trips)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace {

// presence:{user} as Redis holds it, nullopt when the key does not exist.
std::optional<std::string> presenceOf(harness::Ctx& ctx, const std::string& user) {
  return ctx.Redis.Get("presence:" + user);
}

}  // namespace

void CheckTtl(harness::Ctx& ctx) {
  heartbeat("ana", "srv-a");
  ctx.Equal(presenceOf(ctx, "ana"), "srv-a", "presence:ana");
  long long ttl = ctx.Redis.TTL("presence:ana");
  ctx.Assert(25 <= ttl && ttl <= 30, "presence:ana has TTL %d, expected 30 s", ttl);
  ctx.Clock.Advance(20);
  heartbeat("ana", "srv-a");
  ttl = ctx.Redis.TTL("presence:ana");
  ctx.Assert(25 <= ttl && ttl <= 30, "a heartbeat must restart the 30 s lease; TTL after the second beat is %d", ttl);
  ctx.Clock.Advance(31);
  ctx.Equal(presenceOf(ctx, "ana"), nullptr, "a user who stopped heartbeating must vanish after 30 s: presence:ana");
}

void CheckMembership(harness::Ctx& ctx) {
  join_room("room-7", "ana");
  join_room("room-7", "bo");
  join_room("room-7", "ana");
  ctx.Equal(ctx.Redis.SMembers("room:room-7:members"), {"ana", "bo"}, "room:room-7:members (a set: joining twice adds once)");
  leave("room-7", "ana");
  ctx.Equal(ctx.Redis.SMembers("room:room-7:members"), {"bo"}, "after ana leaves, room:room-7:members");
}

void CheckLeaveClears(harness::Ctx& ctx) {
  join_room("room-7", "ana");
  heartbeat("ana", "srv-a");
  leave("room-7", "ana");
  ctx.Equal(presenceOf(ctx, "ana"), nullptr,
            "an explicit leave must DEL presence:{user} instead of waiting for the TTL: presence:ana");
  ctx.Assert(!ctx.Redis.SIsMember("room:room-7:members", "ana"), "leave must SREM the user from the room set");
}

void CheckBatched(harness::Ctx& ctx) {
  auto online = online_members("empty-room");
  ctx.Assert(online.empty(), "a room with no members has nobody online: online_members(%q) is %v", "empty-room", online);
  for (const std::string user : {"ana", "bo", "cy"}) join_room("room-7", user);
  heartbeat("ana", "srv-a");
  heartbeat("cy", "srv-b");
  heartbeat("dee", "srv-b");  // alive but not a member of room-7
  online = online_members("room-7");
  ctx.Equal(online, std::map<std::string, std::string>{{"ana", "srv-a"}, {"cy", "srv-b"}},
            "online_members(%q) (bo never heartbeat)", "room-7");
  ctx.Clock.Advance(31);
  heartbeat("ana", "srv-a");
  online = online_members("room-7");
  ctx.Equal(online, std::map<std::string, std::string>{{"ana", "srv-a"}}, "after cy's lease expired online_members(%q)",
            "room-7");
  // Round trips: one SMEMBERS plus one MGET (or one pipeline), never a GET per member.
  const size_t before = ctx.Redis.RoundTrips().size();
  online_members("room-7");
  const auto all = ctx.Redis.RoundTrips();
  const std::vector<std::vector<std::string>> trips(all.begin() + static_cast<long>(before), all.end());
  std::vector<std::string> calls;
  for (const auto& trip : trips) calls.insert(calls.end(), trip.begin(), trip.end());
  const auto has = [&](const std::string& name) { return std::find(calls.begin(), calls.end(), name) != calls.end(); };
  ctx.Assert(!has("GET"), "online_members issued %v: resolve every presence key in one MGET or one pipeline, not a GET per member",
             trips);
  ctx.Assert(has("MGET") || trips.size() <= 2, "online_members issued %v: expected SMEMBERS then one MGET (or one pipeline)",
             trips);
}
`,
  },
  debrief: `Presence is the canonical use of a TTL as a *liveness lease*: the client renews it, and the absence of renewals is the failure signal — no health checker, no reaper job. Membership stays in a separate set because it outlives the connection. The MGET is the part that scales: one round trip per room view instead of one per member. Real systems shard presence by user, publish transitions (online → offline) instead of polling, and keep a "last seen" timestamp next to the lease so the UI can say "5 minutes ago".`,
};
