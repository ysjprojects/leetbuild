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
  debrief: `Presence is the canonical use of a TTL as a *liveness lease*: the client renews it, and the absence of renewals is the failure signal — no health checker, no reaper job. Membership stays in a separate set because it outlives the connection. The MGET is the part that scales: one round trip per room view instead of one per member. Real systems shard presence by user, publish transitions (online → offline) instead of polling, and keep a "last seen" timestamp next to the lease so the UI can say "5 minutes ago".`,
};
