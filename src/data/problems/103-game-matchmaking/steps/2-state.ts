import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'One Lua script claims the whole roster or none of it',
  concept: 'redis',
  guides: ['atomic-state'],
  file: 'state',
  focus: ['matchmaker', 'redis'],
  task: `## Task

**Starting point.** The starter is the pool module the matchmaker calls once it has picked a
roster. \`claim_tickets(match_id, bucket, ticket_ids)\` walks the roster and, per ticket, reads
\`state\` from \`ticket:{id}\`, \`ZREM\`s it from \`pool:{bucket}\` and sets \`state=claimed\` and
\`match_id\`, then decrements \`pool:depth\`; \`cancel_ticket(ticket_id)\` deletes the ticket and its
owner's \`open:{player}\`. It passes the one-matchmaker demo and hides 4 flaws.

**Failure mode the checks target.** Two matchmakers pick overlapping rosters from one pool, and
every command of the walk is a window for the other: one player is claimed into two matches. A
refused claim leaves the tickets it already took claimed by a match that never forms, the depth
counter drifts away from the pool, and a cancelled ticket stays in the pool for the next claim.

- Claim the roster in **one Lua script**: check that every ticket is \`waiting\` first; if one is
  not, return 0 and touch nothing.
- Only then \`ZREM\` each ticket, set \`state=claimed\` and \`match_id\`, and move \`pool:depth\` by
  the number of tickets claimed.
- \`cancel_ticket\` is one script too: a ticket that is not \`waiting\` is refused (\`False\`);
  otherwise \`ZREM\` it, depth -1, delete every participant's \`open:{player}\` that still holds it,
  then the ticket.`,
  sequence: {
    participants: ['Matchmaker A', 'Matchmaker B', 'Redis'],
    messages: [
      {
        from: 'Matchmaker A',
        to: 'Redis',
        label: 'EVAL claim pool:15 pool:depth ticket:t1 ticket:t2 · m-1',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'all waiting? ZREM · HSET claimed · HINCRBY depth -2', kind: 'sync'},
      {from: 'Redis', to: 'Matchmaker A', label: '1', kind: 'reply'},
      {from: 'Matchmaker B', to: 'Redis', label: 'EVAL claim … ticket:t2 ticket:t3 · m-2', kind: 'sync'},
      {from: 'Redis', to: 'Matchmaker B', label: '0: t2 is claimed, t3 untouched', kind: 'reply'},
      {from: 'Matchmaker B', to: 'Redis', label: 'EVAL cancel ticket:t3 · ZREM · depth -1 · DEL open:*', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'A roster is claimed by one script',
      detail:
        'The claim runs as one Lua script (`EVAL`/`register_script`/`NewScript`), so a second matchmaker cannot land between its commands; no client-side `ZREM`/`HSET` of a ticket.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]ZREM['"]/], none: [/\br\.(zrem|hset)\(/]},
        typescript: {all: [/\.eval\(|defineCommand\(/, /redis\.call\(\s*['"]ZREM['"]/], none: [/redis\.(zrem|hset)\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]ZREM['"]/], none: [/rdb\.(ZRem|HSet)\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]ZREM['"]/], none: [/jedis\.(zrem|hset)\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]ZREM['"]/], none: [/redis\.(zrem|hset)\(/]},
      },
    },
    {
      id: 'all-or-nothing',
      title: 'A refused claim takes no ticket',
      detail:
        'The script checks `state` on every ticket and returns 0 before its first `ZREM`, so a roster with one ticket already in a match leaves the other tickets waiting.',
      match: {
        python: {
          order: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]state['"]/, /return 0/, /redis\.call\(\s*['"]ZREM['"]/],
        },
        typescript: {
          order: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]state['"]/, /return 0/, /redis\.call\(\s*['"]ZREM['"]/],
        },
        go: {order: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]state['"]/, /return 0/, /redis\.call\(\s*['"]ZREM['"]/]},
        scala: {order: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]state['"]/, /return 0/, /redis\.call\(\s*['"]ZREM['"]/]},
        cpp: {order: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]state['"]/, /return 0/, /redis\.call\(\s*['"]ZREM['"]/]},
      },
    },
    {
      id: 'depth-counter',
      title: 'pool:depth moves by the tickets claimed',
      detail:
        'The script moves `pool:depth` by the number of tickets it took out of the pool (a refused claim moves it by none), so the counter always equals what waits in the pool; the starter subtracts one per claim.',
      match: {
        python: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrby\([^)\n]*,\s*-1\s*\)/]},
        typescript: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrby\([^)\n]*,\s*-1\s*\)/]},
        go: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.HIncrBy\([^)\n]*,\s*-1\s*\)/]},
        scala: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrBy\([^)\n]*,\s*-1L?\s*\)/]},
        cpp: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrby\([^)\n]*,\s*-1\s*\)/]},
      },
    },
    {
      id: 'cancel-leaves-pool',
      title: 'A cancelled ticket leaves the pool, the counter and every pointer',
      detail:
        "`cancel_ticket` refuses a ticket that is not `waiting` and otherwise removes it from `pool:{bucket}`, decrements `pool:depth` and deletes every participant's `open:{player}`, in one script; the starter deletes the ticket hash and the owner's pointer only.",
      match: {
        python: {all: [/\[["']participants["']\]/, /register_script\(|\.eval\(/], none: [/\br\.delete\(/]},
        typescript: {all: [/\.participants\b/, /\.eval\(|defineCommand\(/], none: [/redis\.del\(/]},
        go: {all: [/\.Participants\b/, /redis\.NewScript\(|\.Eval\(/], none: [/rdb\.Del\(/]},
        scala: {all: [/\.participants\b/, /jedis\.eval(sha)?\(/], none: [/jedis\.del\(/]},
        cpp: {all: [/->participants|\.participants\b/, /redis\.eval(sha)?[<(]/], none: [/redis\.del\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from matchmaking import store  # get_ticket, ticket_key, pool_key, open_key, DEPTH_KEY

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def claim_tickets(match_id: str, bucket: int, ticket_ids: list[str]) -> bool:
    """Claim every ticket of the roster for match_id; False when one of them is no longer waiting."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    for ticket_id in ticket_ids:
        if r.hget(store.ticket_key(ticket_id), "state") != "waiting":
            return False
        r.zrem(store.pool_key(bucket), ticket_id)
        r.hset(store.ticket_key(ticket_id), mapping={"state": "claimed", "match_id": match_id})
    r.hincrby(store.DEPTH_KEY, str(bucket), -1)
    return True


def cancel_ticket(ticket_id: str) -> bool:
    """The players leave the queue; False when the ticket is unknown or already in a match."""
    ticket = store.get_ticket(ticket_id)
    if ticket is None:
        return False
    r.delete(store.ticket_key(ticket_id), store.open_key(ticket["owner"]))
    return True
`,
      solution: `import redis

from matchmaking import store  # get_ticket, ticket_key, pool_key, open_key, DEPTH_KEY

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket.
# Every ticket is checked before the first write: a refused claim touches nothing.
CLAIM_LUA = """
for i = 3, #KEYS do
  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
end
for i = 3, #KEYS do
  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
end
redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
return 1
"""

# KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket.
CANCEL_LUA = """
if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
for i = 4, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
redis.call('DEL', KEYS[1])
return 1
"""

claim = r.register_script(CLAIM_LUA)
cancel = r.register_script(CANCEL_LUA)


def claim_tickets(match_id: str, bucket: int, ticket_ids: list[str]) -> bool:
    """Claim every ticket of the roster for match_id; False, touching nothing, when one is not waiting."""
    keys = [store.pool_key(bucket), store.DEPTH_KEY, *[store.ticket_key(t) for t in ticket_ids]]
    return claim(keys=keys, args=[match_id, bucket]) == 1


def cancel_ticket(ticket_id: str) -> bool:
    """The players leave the queue; False when the ticket is unknown or already in a match."""
    ticket = store.get_ticket(ticket_id)
    if ticket is None:
        return False
    keys = [store.ticket_key(ticket_id), store.pool_key(ticket["bucket"]), store.DEPTH_KEY]
    keys += [store.open_key(p) for p in ticket["participants"]]
    return cancel(keys=keys, args=[ticket_id, ticket["bucket"]]) == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {DEPTH_KEY, getTicket, openKey, poolKey, ticketKey} from 'matchmaking/store';

const redis = new Redis({host: 'redis', port: 6379});

/** Claim every ticket of the roster for matchId; false when one of them is no longer waiting. */
export async function claimTickets(matchId: string, bucket: number, ticketIds: string[]): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  for (const ticketId of ticketIds) {
    if ((await redis.hget(ticketKey(ticketId), 'state')) !== 'waiting') return false;
    await redis.zrem(poolKey(bucket), ticketId);
    await redis.hset(ticketKey(ticketId), {state: 'claimed', match_id: matchId});
  }
  await redis.hincrby(DEPTH_KEY, String(bucket), -1);
  return true;
}

/** The players leave the queue; false when the ticket is unknown or already in a match. */
export async function cancelTicket(ticketId: string): Promise<boolean> {
  const ticket = await getTicket(ticketId);
  if (ticket === null) return false;
  await redis.del(ticketKey(ticketId), openKey(ticket.owner));
  return true;
}
`,
      solution: `import Redis from 'ioredis';

import {DEPTH_KEY, getTicket, openKey, poolKey, ticketKey} from 'matchmaking/store';

const redis = new Redis({host: 'redis', port: 6379});

/**
 * KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket.
 * Every ticket is checked before the first write: a refused claim touches nothing.
 */
export const CLAIM_LUA = \`
for i = 3, #KEYS do
  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
end
for i = 3, #KEYS do
  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
end
redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
return 1
\`;

/** KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket. */
export const CANCEL_LUA = \`
if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
for i = 4, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
redis.call('DEL', KEYS[1])
return 1
\`;

/** Claim every ticket of the roster for matchId; false, touching nothing, when one is not waiting. */
export async function claimTickets(matchId: string, bucket: number, ticketIds: string[]): Promise<boolean> {
  const keys = [poolKey(bucket), DEPTH_KEY, ...ticketIds.map(ticketKey)];
  return (await redis.eval(CLAIM_LUA, keys.length, ...keys, matchId, String(bucket))) === 1;
}

/** The players leave the queue; false when the ticket is unknown or already in a match. */
export async function cancelTicket(ticketId: string): Promise<boolean> {
  const ticket = await getTicket(ticketId);
  if (ticket === null) return false;
  const keys = [ticketKey(ticketId), poolKey(ticket.bucket), DEPTH_KEY, ...ticket.participants.map(openKey)];
  return (await redis.eval(CANCEL_LUA, keys.length, ...keys, ticketId, String(ticket.bucket))) === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"matchmaking/store" // store.GetTicket, TicketKey, PoolKey, OpenKey, DepthKey
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// claimTickets claims every ticket of the roster for matchID; false when one of them is no longer waiting.
func claimTickets(ctx context.Context, matchID string, bucket int, ticketIDs []string) (bool, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	for _, ticketID := range ticketIDs {
		if rdb.HGet(ctx, store.TicketKey(ticketID), "state").Val() != "waiting" {
			return false, nil
		}
		rdb.ZRem(ctx, store.PoolKey(bucket), ticketID)
		rdb.HSet(ctx, store.TicketKey(ticketID), "state", "claimed", "match_id", matchID)
	}
	rdb.HIncrBy(ctx, store.DepthKey, strconv.Itoa(bucket), -1)
	return true, nil
}

// cancelTicket takes the players out of the queue; false when the ticket is unknown or already in a match.
func cancelTicket(ctx context.Context, ticketID string) (bool, error) {
	t := store.GetTicket(ctx, ticketID)
	if t == nil {
		return false, nil
	}
	rdb.Del(ctx, store.TicketKey(ticketID), store.OpenKey(t.Owner))
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"matchmaking/store" // store.GetTicket, TicketKey, PoolKey, OpenKey, DepthKey
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket.
// Every ticket is checked before the first write: a refused claim touches nothing.
var claimScript = redis.NewScript(\`
for i = 3, #KEYS do
  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
end
for i = 3, #KEYS do
  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
end
redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
return 1
\`)

// KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket.
var cancelScript = redis.NewScript(\`
if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
for i = 4, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
redis.call('DEL', KEYS[1])
return 1
\`)

// claimTickets claims every ticket of the roster for matchID; false, touching nothing, when one is not waiting.
func claimTickets(ctx context.Context, matchID string, bucket int, ticketIDs []string) (bool, error) {
	keys := []string{store.PoolKey(bucket), store.DepthKey}
	for _, t := range ticketIDs {
		keys = append(keys, store.TicketKey(t))
	}
	n, err := claimScript.Run(ctx, rdb, keys, matchID, strconv.Itoa(bucket)).Int64()
	return n == 1, err
}

// cancelTicket takes the players out of the queue; false when the ticket is unknown or already in a match.
func cancelTicket(ctx context.Context, ticketID string) (bool, error) {
	t := store.GetTicket(ctx, ticketID)
	if t == nil {
		return false, nil
	}
	keys := []string{store.TicketKey(ticketID), store.PoolKey(t.Bucket), store.DepthKey}
	for _, p := range t.Participants {
		keys = append(keys, store.OpenKey(p))
	}
	n, err := cancelScript.Run(ctx, rdb, keys, ticketID, strconv.Itoa(t.Bucket)).Int64()
	return n == 1, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import matchmaking.Store // Store.getTicket, ticketKey, poolKey, openKey, DepthKey

object Pool {
  private val jedis = new JedisPooled("redis", 6379)

  /** Claim every ticket of the roster for matchId; false when one of them is no longer waiting. */
  def claimTickets(matchId: String, bucket: Long, ticketIds: Seq[String]): Boolean = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val refused = ticketIds.exists { ticketId =>
      if (jedis.hget(Store.ticketKey(ticketId), "state") != "waiting") true
      else {
        jedis.zrem(Store.poolKey(bucket), ticketId)
        jedis.hset(Store.ticketKey(ticketId), Map("state" -> "claimed", "match_id" -> matchId).asJava)
        false
      }
    }
    if (!refused) jedis.hincrBy(Store.DepthKey, bucket.toString, -1L)
    !refused
  }

  /** The players leave the queue; false when the ticket is unknown or already in a match. */
  def cancelTicket(ticketId: String): Boolean = Store.getTicket(ticketId) match {
    case None => false
    case Some(ticket) =>
      jedis.del(Store.ticketKey(ticketId), Store.openKey(ticket.owner))
      true
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import matchmaking.Store // Store.getTicket, ticketKey, poolKey, openKey, DepthKey

object Pool {
  private val jedis = new JedisPooled("redis", 6379)

  /**
   * KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket.
   * Every ticket is checked before the first write: a refused claim touches nothing.
   */
  val ClaimLua: String =
    """for i = 3, #KEYS do
      |  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
      |end
      |for i = 3, #KEYS do
      |  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
      |  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
      |end
      |redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
      |return 1
      |""".stripMargin

  /** KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket. */
  val CancelLua: String =
    """if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
      |redis.call('ZREM', KEYS[2], ARGV[1])
      |redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
      |for i = 4, #KEYS do
      |  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
      |end
      |redis.call('DEL', KEYS[1])
      |return 1
      |""".stripMargin

  /** Claim every ticket of the roster for matchId; false, touching nothing, when one is not waiting. */
  def claimTickets(matchId: String, bucket: Long, ticketIds: Seq[String]): Boolean = {
    val keys = Seq(Store.poolKey(bucket), Store.DepthKey) ++ ticketIds.map(Store.ticketKey)
    jedis.eval(ClaimLua, keys.asJava, Seq(matchId, bucket.toString).asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** The players leave the queue; false when the ticket is unknown or already in a match. */
  def cancelTicket(ticketId: String): Boolean = Store.getTicket(ticketId) match {
    case None => false
    case Some(ticket) =>
      val keys = Seq(Store.ticketKey(ticketId), Store.poolKey(ticket.bucket), Store.DepthKey) ++ ticket.participants.map(Store.openKey)
      jedis.eval(CancelLua, keys.asJava, Seq(ticketId, ticket.bucket.toString).asJava).asInstanceOf[java.lang.Long] == 1L
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "matchmaking/store.h"  // store::getTicket, ticketKey, poolKey, openKey, kDepthKey

sw::redis::Redis redis("tcp://redis:6379");

// Claim every ticket of the roster for match_id; false when one of them is no longer waiting.
bool claimTickets(const std::string& match_id, long bucket, const std::vector<std::string>& ticket_ids) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  for (const std::string& ticket_id : ticket_ids) {
    const auto state = redis.hget(store::ticketKey(ticket_id), "state");
    if (!state || *state != "waiting") return false;
    redis.zrem(store::poolKey(bucket), ticket_id);
    redis.hset(store::ticketKey(ticket_id), {{"state", "claimed"}, {"match_id", match_id}});
  }
  redis.hincrby(store::kDepthKey, std::to_string(bucket), -1);
  return true;
}

// The players leave the queue; false when the ticket is unknown or already in a match.
bool cancelTicket(const std::string& ticket_id) {
  const auto ticket = store::getTicket(ticket_id);
  if (!ticket) return false;
  redis.del(store::ticketKey(ticket_id));
  redis.del(store::openKey(ticket->owner));
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "matchmaking/store.h"  // store::getTicket, ticketKey, poolKey, openKey, kDepthKey

sw::redis::Redis redis("tcp://redis:6379");

// KEYS: pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket.
// Every ticket is checked before the first write: a refused claim touches nothing.
const std::string kClaimLua = R"lua(
for i = 3, #KEYS do
  if redis.call('HGET', KEYS[i], 'state') ~= 'waiting' then return 0 end
end
for i = 3, #KEYS do
  redis.call('ZREM', KEYS[1], redis.call('HGET', KEYS[i], 'ticket_id'))
  redis.call('HSET', KEYS[i], 'state', 'claimed', 'match_id', ARGV[1])
end
redis.call('HINCRBY', KEYS[2], ARGV[2], -(#KEYS - 2))
return 1
)lua";

// KEYS: ticket:{id}, pool:{bucket}, pool:depth, open:{player}…; ARGV: ticket id, bucket.
const std::string kCancelLua = R"lua(
if redis.call('HGET', KEYS[1], 'state') ~= 'waiting' then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[3], ARGV[2], -1)
for i = 4, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
redis.call('DEL', KEYS[1])
return 1
)lua";

// Claim every ticket of the roster for match_id; false, touching nothing, when one is not waiting.
bool claimTickets(const std::string& match_id, long bucket, const std::vector<std::string>& ticket_ids) {
  std::vector<std::string> keys = {store::poolKey(bucket), store::kDepthKey};
  for (const std::string& t : ticket_ids) keys.push_back(store::ticketKey(t));
  const std::vector<std::string> args = {match_id, std::to_string(bucket)};
  return redis.eval<long long>(kClaimLua, keys, args) == 1;
}

// The players leave the queue; false when the ticket is unknown or already in a match.
bool cancelTicket(const std::string& ticket_id) {
  const auto ticket = store::getTicket(ticket_id);
  if (!ticket) return false;
  std::vector<std::string> keys = {store::ticketKey(ticket_id), store::poolKey(ticket->bucket), store::kDepthKey};
  for (const std::string& p : ticket->participants) keys.push_back(store::openKey(p));
  const std::vector<std::string> args = {ticket_id, std::to_string(ticket->bucket)};
  return redis.eval<long long>(kCancelLua, keys, args) == 1;
}
`,
    },
  },
  harness: {
    python: `from matchmaking import store


def _setup(ctx, n=3):
    """t1..tn wait in pool:15, each a solo ticket of p1..pn holding open:{p}."""
    for i in range(1, n + 1):
        store.enqueue(f"t{i}", f"p{i}", 1500 + i, [f"p{i}"])
        ctx.redis.set(f"open:p{i}", f"t{i}")


def _pool(ctx):
    return sorted(ctx.redis.zrange("pool:15", 0, -1))


def _depth(ctx):
    return int(ctx.redis.hget("pool:depth", "15") or 0)


def _waiting(ticket_id):
    t = store.get_ticket(ticket_id)
    return t is not None and t["state"] == "waiting" and t["match_id"] is None


def check_atomic_claim(ctx):
    m = ctx.load("state")
    _setup(ctx)
    # A second matchmaker claims [t2, t3] the moment this one first touches t2.
    rival = ctx.redis_after("ticket:t2", lambda: m.claim_tickets("m-2", 15, ["t2", "t3"]))
    mine = m.claim_tickets("m-1", 15, ["t1", "t2"])
    assert rival.fired, "claim_tickets never touched ticket:t2"
    if rival.error is not None:
        raise rival.error
    theirs = rival.result
    assert [mine, theirs].count(True) == 1, f"two matchmakers claimed the overlapping rosters [t1, t2] and [t2, t3] and got m-1: {mine}, m-2: {theirs}; t2 is now {store.get_ticket('t2')}. Exactly one claim may win, or a player is placed in two games"
    winner, other = ("m-1", "t3") if mine else ("m-2", "t1")
    assert store.get_ticket("t2")["match_id"] == winner, f"t2 belongs to {store.get_ticket('t2')['match_id']}, but the claim that won was {winner}'s"
    assert _waiting(other) and other in _pool(ctx), f"{other} was only on the losing roster and must still wait in pool:15: {store.get_ticket(other)}, pool {_pool(ctx)}"
    assert _depth(ctx) == len(_pool(ctx)), f"pool:depth says {_depth(ctx)} tickets wait in bucket 15, pool:15 holds {_pool(ctx)}"


def check_all_or_nothing(ctx):
    m = ctx.load("state")
    _setup(ctx)
    assert m.claim_tickets("m-0", 15, ["t2"]) is True, "claiming the waiting ticket t2 must succeed"
    assert m.claim_tickets("m-1", 15, ["t1", "t2"]) is False, "t2 is already in m-0: the roster [t1, t2] cannot be claimed"
    assert _waiting("t1") and "t1" in _pool(ctx), f"the refused claim left t1 as {store.get_ticket('t1')} (pool {_pool(ctx)}): a ticket claimed by a match that never forms, its player stuck in neither"
    assert store.get_ticket("t2")["match_id"] == "m-0", f"the refused claim took t2 from m-0: {store.get_ticket('t2')}"
    assert m.claim_tickets("m-3", 15, ["t3", "t9"]) is False, "a roster with an unknown ticket t9 cannot be claimed"
    assert _waiting("t3") and "t3" in _pool(ctx), f"the claim refused for the unknown t9 left t3 as {store.get_ticket('t3')}"


def check_depth_counter(ctx):
    m = ctx.load("state")
    _setup(ctx)
    assert _depth(ctx) == 3, f"three tickets were queued and pool:depth says {_depth(ctx)}"
    assert m.claim_tickets("m-1", 15, ["t1", "t2"]) is True, "claiming t1 and t2 must succeed"
    assert _depth(ctx) == 1 and _pool(ctx) == ["t3"], f"after a claim of two tickets pool:depth is {_depth(ctx)} and pool:15 holds {_pool(ctx)}: the counter must move by the tickets claimed"
    assert m.claim_tickets("m-2", 15, ["t1"]) is False, "t1 is already claimed"
    assert _depth(ctx) == 1, f"a refused claim moved pool:depth to {_depth(ctx)}"
    assert m.claim_tickets("m-3", 15, ["t3"]) is True and _depth(ctx) == 0, f"after the last ticket was claimed pool:depth is {_depth(ctx)}"


def check_cancel_leaves_pool(ctx):
    m = ctx.load("state")
    store.enqueue("t1", "p1", 1501, ["p1", "p2"])
    ctx.redis.set("open:p1", "t1")
    ctx.redis.set("open:p2", "t1")
    store.enqueue("t2", "p3", 1502, ["p3"])
    ctx.redis.set("open:p3", "t2")
    assert m.claim_tickets("m-1", 15, ["t2"]) is True, "claiming t2 must succeed"
    assert m.cancel_ticket("t1") is True, "cancelling the waiting ticket t1 must succeed"
    assert "t1" not in _pool(ctx), f"the cancelled t1 still waits in pool:15 {_pool(ctx)}: the next matchmaker claims a ticket nobody is behind"
    assert _depth(ctx) == len(_pool(ctx)), f"after the cancel pool:depth is {_depth(ctx)}, pool:15 holds {_pool(ctx)}"
    assert ctx.redis.exists("ticket:t1") == 0, "the cancelled ticket's hash must be gone"
    left = [p for p in ("open:p1", "open:p2") if ctx.redis.exists(p)]
    assert not left, f"{left} still point at the cancelled ticket: those players cannot queue again until it expires"
    assert m.cancel_ticket("t2") is False, "t2 is in match m-1: cancelling it must be refused"
    assert store.get_ticket("t2")["match_id"] == "m-1" and ctx.redis.get("open:p3") == "t2", f"a refused cancel changed t2: {store.get_ticket('t2')}, open:p3 = {ctx.redis.get('open:p3')}"
`,
    typescript: `async function setup(ctx, store, n = 3) {
  for (let i = 1; i <= n; i++) {
    await store.enqueue(\`t\${i}\`, \`p\${i}\`, 1500 + i, [\`p\${i}\`]);
    ctx.redis.set(\`open:p\${i}\`, \`t\${i}\`);
  }
}

const pool = (ctx): string[] => (ctx.redis.zrange('pool:15', 0, -1) as string[]).slice().sort();
const depth = (ctx): number => Number(ctx.redis.hget('pool:depth', '15') ?? 0);

async function waiting(store, ticketId: string): Promise<boolean> {
  const t = await store.getTicket(ticketId);
  return t !== null && t.state === 'waiting' && t.match_id === null;
}

function load(ctx) {
  return {m: ctx.load('state'), store: ctx.load('/support/matchmaking/store.ts')};
}

export async function check_atomic_claim(ctx) {
  const {m, store} = load(ctx);
  await setup(ctx, store);
  // A second matchmaker claims [t2, t3] the moment this one first touches t2.
  const rival = ctx.redisAfter('ticket:t2', () => m.claimTickets('m-2', 15, ['t2', 't3']));
  const mine = await m.claimTickets('m-1', 15, ['t1', 't2']);
  assert(rival.fired, 'claimTickets never touched ticket:t2');
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const t2 = await store.getTicket('t2');
  assert([mine, theirs].filter(Boolean).length === 1, \`two matchmakers claimed the overlapping rosters [t1, t2] and [t2, t3] and got m-1: \${mine}, m-2: \${theirs}; t2 is now \${JSON.stringify(t2)}. Exactly one claim may win, or a player is placed in two games\`);
  const [winner, other] = mine ? ['m-1', 't3'] : ['m-2', 't1'];
  assert.equal(t2.match_id, winner, \`t2 belongs to \${t2.match_id}, but the claim that won was \${winner}'s\`);
  assert((await waiting(store, other)) && pool(ctx).includes(other), \`\${other} was only on the losing roster and must still wait in pool:15: \${JSON.stringify(await store.getTicket(other))}, pool \${JSON.stringify(pool(ctx))}\`);
  assert.equal(depth(ctx), pool(ctx).length, \`pool:depth says \${depth(ctx)} tickets wait in bucket 15, pool:15 holds \${JSON.stringify(pool(ctx))}\`);
}

export async function check_all_or_nothing(ctx) {
  const {m, store} = load(ctx);
  await setup(ctx, store);
  assert.equal(await m.claimTickets('m-0', 15, ['t2']), true, 'claiming the waiting ticket t2 must succeed');
  assert.equal(await m.claimTickets('m-1', 15, ['t1', 't2']), false, 't2 is already in m-0: the roster [t1, t2] cannot be claimed');
  assert((await waiting(store, 't1')) && pool(ctx).includes('t1'), \`the refused claim left t1 as \${JSON.stringify(await store.getTicket('t1'))} (pool \${JSON.stringify(pool(ctx))}): a ticket claimed by a match that never forms, its player stuck in neither\`);
  assert.equal((await store.getTicket('t2')).match_id, 'm-0', 'the refused claim took t2 from m-0');
  assert.equal(await m.claimTickets('m-3', 15, ['t3', 't9']), false, 'a roster with an unknown ticket t9 cannot be claimed');
  assert((await waiting(store, 't3')) && pool(ctx).includes('t3'), \`the claim refused for the unknown t9 left t3 as \${JSON.stringify(await store.getTicket('t3'))}\`);
}

export async function check_depth_counter(ctx) {
  const {m, store} = load(ctx);
  await setup(ctx, store);
  assert.equal(depth(ctx), 3, \`three tickets were queued and pool:depth says \${depth(ctx)}\`);
  assert.equal(await m.claimTickets('m-1', 15, ['t1', 't2']), true, 'claiming t1 and t2 must succeed');
  assert(depth(ctx) === 1 && JSON.stringify(pool(ctx)) === '["t3"]', \`after a claim of two tickets pool:depth is \${depth(ctx)} and pool:15 holds \${JSON.stringify(pool(ctx))}: the counter must move by the tickets claimed\`);
  assert.equal(await m.claimTickets('m-2', 15, ['t1']), false, 't1 is already claimed');
  assert.equal(depth(ctx), 1, \`a refused claim moved pool:depth to \${depth(ctx)}\`);
  assert((await m.claimTickets('m-3', 15, ['t3'])) === true && depth(ctx) === 0, \`after the last ticket was claimed pool:depth is \${depth(ctx)}\`);
}

export async function check_cancel_leaves_pool(ctx) {
  const {m, store} = load(ctx);
  await store.enqueue('t1', 'p1', 1501, ['p1', 'p2']);
  ctx.redis.set('open:p1', 't1');
  ctx.redis.set('open:p2', 't1');
  await store.enqueue('t2', 'p3', 1502, ['p3']);
  ctx.redis.set('open:p3', 't2');
  assert.equal(await m.claimTickets('m-1', 15, ['t2']), true, 'claiming t2 must succeed');
  assert.equal(await m.cancelTicket('t1'), true, 'cancelling the waiting ticket t1 must succeed');
  assert(!pool(ctx).includes('t1'), \`the cancelled t1 still waits in pool:15 \${JSON.stringify(pool(ctx))}: the next matchmaker claims a ticket nobody is behind\`);
  assert.equal(depth(ctx), pool(ctx).length, \`after the cancel pool:depth is \${depth(ctx)}, pool:15 holds \${JSON.stringify(pool(ctx))}\`);
  assert.equal(ctx.redis.exists('ticket:t1'), 0, "the cancelled ticket's hash must be gone");
  const left = ['open:p1', 'open:p2'].filter(k => ctx.redis.exists(k));
  assert.deepStrictEqual(left, [], \`\${JSON.stringify(left)} still point at the cancelled ticket: those players cannot queue again until it expires\`);
  assert.equal(await m.cancelTicket('t2'), false, 't2 is in match m-1: cancelling it must be refused');
  const t2 = await store.getTicket('t2');
  assert(t2.match_id === 'm-1' && ctx.redis.get('open:p3') === 't2', \`a refused cancel changed t2: \${JSON.stringify(t2)}, open:p3 = \${ctx.redis.get('open:p3')}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"

	"matchmaking/store"

	"leetbuild/harness"
)

var poolBg = context.Background()

// poolSetup queues t1..tn in pool:15, each a solo ticket of p1..pn holding open:{p}.
func poolSetup(ctx *harness.Ctx, n int) {
	for i := 1; i <= n; i++ {
		store.Enqueue(poolBg, fmt.Sprintf("t%d", i), fmt.Sprintf("p%d", i), 1500+i, []string{fmt.Sprintf("p%d", i)})
		ctx.Redis.Set(fmt.Sprintf("open:p%d", i), fmt.Sprintf("t%d", i))
	}
}

func poolMembers(ctx *harness.Ctx) []string {
	ids := []string{}
	for _, z := range ctx.Redis.ZRangeWithScores("pool:15", 0, -1) {
		ids = append(ids, z.Member)
	}
	sort.Strings(ids)
	return ids
}

func poolDepth(ctx *harness.Ctx) int {
	v, _ := ctx.Redis.HGet("pool:depth", "15")
	n, _ := strconv.Atoi(v)
	return n
}

func poolHas(ctx *harness.Ctx, ticketID string) bool {
	_, ok := ctx.Redis.ZScore("pool:15", ticketID)
	return ok
}

func poolWaiting(ticketID string) bool {
	t := store.GetTicket(poolBg, ticketID)
	return t != nil && t.State == "waiting" && t.MatchID == ""
}

func mustClaim(ctx *harness.Ctx, matchID string, ticketIDs ...string) bool {
	ok, err := claimTickets(poolBg, matchID, 15, ticketIDs)
	ctx.NoError(err, "claimTickets(%s, 15, %v)", matchID, ticketIDs)
	return ok
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	poolSetup(ctx, 3)
	// A second matchmaker claims [t2, t3] the moment this one first touches t2.
	rival := ctx.Redis.After("ticket:t2", func() any {
		ok, err := claimTickets(poolBg, "m-2", 15, []string{"t2", "t3"})
		ctx.NoError(err, "the rival claim")
		return ok
	})
	mine := mustClaim(ctx, "m-1", "t1", "t2")
	ctx.Assert(rival.Fired, "claimTickets never touched ticket:t2")
	ctx.Assert(rival.Err == nil, "the rival claim failed: %v", rival.Err)
	theirs, _ := rival.Result.(bool)
	ctx.Assert(mine != theirs, "two matchmakers claimed the overlapping rosters [t1, t2] and [t2, t3] and got m-1: %t, m-2: %t; t2 is now %+v. Exactly one claim may win, or a player is placed in two games", mine, theirs, store.GetTicket(poolBg, "t2"))
	winner, other := "m-2", "t1"
	if mine {
		winner, other = "m-1", "t3"
	}
	ctx.Equal(store.GetTicket(poolBg, "t2").MatchID, winner, "t2's match (the claim that won was %s's)", winner)
	ctx.Assert(poolWaiting(other) && poolHas(ctx, other), "%s was only on the losing roster and must still wait in pool:15: %+v, pool %v", other, store.GetTicket(poolBg, other), poolMembers(ctx))
	ctx.Equal(poolDepth(ctx), len(poolMembers(ctx)), "pool:depth must equal what waits in pool:15 %v; the depth", poolMembers(ctx))
}

func CheckAllOrNothing(ctx *harness.Ctx) {
	poolSetup(ctx, 3)
	ctx.Equal(mustClaim(ctx, "m-0", "t2"), true, "claiming the waiting ticket t2")
	ctx.Equal(mustClaim(ctx, "m-1", "t1", "t2"), false, "t2 is already in m-0: claiming the roster [t1, t2]")
	ctx.Assert(poolWaiting("t1") && poolHas(ctx, "t1"), "the refused claim left t1 as %+v (pool %v): a ticket claimed by a match that never forms, its player stuck in neither", store.GetTicket(poolBg, "t1"), poolMembers(ctx))
	ctx.Equal(store.GetTicket(poolBg, "t2").MatchID, "m-0", "the refused claim must not take t2 from m-0; t2's match")
	ctx.Equal(mustClaim(ctx, "m-3", "t3", "t9"), false, "a roster with an unknown ticket t9")
	ctx.Assert(poolWaiting("t3") && poolHas(ctx, "t3"), "the claim refused for the unknown t9 left t3 as %+v", store.GetTicket(poolBg, "t3"))
}

func CheckDepthCounter(ctx *harness.Ctx) {
	poolSetup(ctx, 3)
	ctx.Equal(poolDepth(ctx), 3, "three tickets were queued; pool:depth")
	ctx.Equal(mustClaim(ctx, "m-1", "t1", "t2"), true, "claiming t1 and t2")
	ctx.Assert(poolDepth(ctx) == 1 && len(poolMembers(ctx)) == 1, "after a claim of two tickets pool:depth is %d and pool:15 holds %v: the counter must move by the tickets claimed", poolDepth(ctx), poolMembers(ctx))
	ctx.Equal(mustClaim(ctx, "m-2", "t1"), false, "t1 is already claimed")
	ctx.Equal(poolDepth(ctx), 1, "a refused claim must not move pool:depth")
	ctx.Equal(mustClaim(ctx, "m-3", "t3"), true, "claiming t3")
	ctx.Equal(poolDepth(ctx), 0, "after the last ticket was claimed, pool:depth")
}

func CheckCancelLeavesPool(ctx *harness.Ctx) {
	store.Enqueue(poolBg, "t1", "p1", 1501, []string{"p1", "p2"})
	ctx.Redis.Set("open:p1", "t1")
	ctx.Redis.Set("open:p2", "t1")
	store.Enqueue(poolBg, "t2", "p3", 1502, []string{"p3"})
	ctx.Redis.Set("open:p3", "t2")
	ctx.Equal(mustClaim(ctx, "m-1", "t2"), true, "claiming t2")
	ok, err := cancelTicket(poolBg, "t1")
	ctx.NoError(err, "cancelTicket(t1)")
	ctx.Equal(ok, true, "cancelling the waiting ticket t1")
	ctx.Assert(!poolHas(ctx, "t1"), "the cancelled t1 still waits in pool:15 %v: the next matchmaker claims a ticket nobody is behind", poolMembers(ctx))
	ctx.Equal(poolDepth(ctx), len(poolMembers(ctx)), "after the cancel pool:depth must equal what waits in pool:15 %v; the depth", poolMembers(ctx))
	ctx.Equal(ctx.Redis.Exists("ticket:t1"), 0, "the cancelled ticket's hash must be gone")
	left := []string{}
	for _, k := range []string{"open:p1", "open:p2"} {
		if ctx.Redis.Exists(k) == 1 {
			left = append(left, k)
		}
	}
	ctx.Assert(len(left) == 0, "%v still point at the cancelled ticket: those players cannot queue again until it expires", left)
	ok, err = cancelTicket(poolBg, "t2")
	ctx.NoError(err, "cancelTicket(t2)")
	ctx.Equal(ok, false, "t2 is in match m-1: cancelling it must be refused")
	pointer, _ := ctx.Redis.Get("open:p3")
	ctx.Assert(store.GetTicket(poolBg, "t2").MatchID == "m-1" && pointer == "t2", "a refused cancel changed t2: %+v, open:p3 = %q", store.GetTicket(poolBg, "t2"), pointer)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "matchmaking/store.h"

namespace {

// t1..tn wait in pool:15, each a solo ticket of p1..pn holding open:{p}.
void poolSetup(harness::Ctx& ctx, int n) {
  for (int i = 1; i <= n; i++) {
    store::enqueue("t" + std::to_string(i), "p" + std::to_string(i), 1500 + i, {"p" + std::to_string(i)});
    ctx.Redis.Set("open:p" + std::to_string(i), "t" + std::to_string(i));
  }
}

std::vector<std::string> poolMembers(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& z : ctx.Redis.ZRangeWithScores("pool:15", 0, -1)) ids.push_back(z.Member);
  std::sort(ids.begin(), ids.end());
  return ids;
}

long poolDepth(harness::Ctx& ctx) {
  const auto v = ctx.Redis.HGet("pool:depth", "15");
  return v && !v->empty() ? std::stol(*v) : 0;
}

bool poolHas(harness::Ctx& ctx, const std::string& ticket_id) { return ctx.Redis.ZScore("pool:15", ticket_id).has_value(); }

bool poolWaiting(const std::string& ticket_id) {
  const auto t = store::getTicket(ticket_id);
  return t && t->state == "waiting" && t->match_id.empty();
}

std::string matchOf(const std::string& ticket_id) {
  const auto t = store::getTicket(ticket_id);
  return t ? t->match_id : "(no ticket)";
}

}  // namespace

void CheckAtomicClaim(harness::Ctx& ctx) {
  poolSetup(ctx, 3);
  // A second matchmaker claims [t2, t3] the moment this one first touches t2.
  auto fired = std::make_shared<bool>(false);
  auto theirs = std::make_shared<bool>(false);
  auto failed = std::make_shared<std::string>();
  ctx.Redis.After("ticket:t2", [fired, theirs, failed] {
    *fired = true;
    try {
      *theirs = claimTickets("m-2", 15, {"t2", "t3"});
    } catch (const std::exception& e) {
      *failed = e.what();
    }
  });
  const bool mine = claimTickets("m-1", 15, {"t1", "t2"});
  ctx.Assert(*fired, "claimTickets never touched ticket:t2");
  ctx.Assert(failed->empty(), "the rival claim failed: %s", *failed);
  ctx.Assert(mine != *theirs, "two matchmakers claimed the overlapping rosters [t1, t2] and [t2, t3] and got m-1: %t, m-2: %t; t2 now belongs to %s. Exactly one claim may win, or a player is placed in two games", mine, *theirs, matchOf("t2"));
  const std::string winner = mine ? "m-1" : "m-2";
  const std::string other = mine ? "t3" : "t1";
  ctx.Equal(matchOf("t2"), winner, "t2's match (the claim that won was %s's)", winner);
  ctx.Assert(poolWaiting(other) && poolHas(ctx, other), "%s was only on the losing roster and must still wait in pool:15 (pool %q)", other, poolMembers(ctx));
  ctx.Equal(poolDepth(ctx), static_cast<long>(poolMembers(ctx).size()), "pool:depth must equal what waits in pool:15 %q; the depth", poolMembers(ctx));
}

void CheckAllOrNothing(harness::Ctx& ctx) {
  poolSetup(ctx, 3);
  ctx.Equal(claimTickets("m-0", 15, {"t2"}), true, "claiming the waiting ticket t2");
  ctx.Equal(claimTickets("m-1", 15, {"t1", "t2"}), false, "t2 is already in m-0: claiming the roster [t1, t2]");
  ctx.Assert(poolWaiting("t1") && poolHas(ctx, "t1"), "the refused claim left t1 claimed by %s (pool %q): a ticket claimed by a match that never forms, its player stuck in neither", matchOf("t1"), poolMembers(ctx));
  ctx.Equal(matchOf("t2"), "m-0", "the refused claim must not take t2 from m-0; t2's match");
  ctx.Equal(claimTickets("m-3", 15, {"t3", "t9"}), false, "a roster with an unknown ticket t9");
  ctx.Assert(poolWaiting("t3") && poolHas(ctx, "t3"), "the claim refused for the unknown t9 left t3 claimed by %s", matchOf("t3"));
}

void CheckDepthCounter(harness::Ctx& ctx) {
  poolSetup(ctx, 3);
  ctx.Equal(poolDepth(ctx), 3, "three tickets were queued; pool:depth");
  ctx.Equal(claimTickets("m-1", 15, {"t1", "t2"}), true, "claiming t1 and t2");
  ctx.Assert(poolDepth(ctx) == 1 && poolMembers(ctx).size() == 1, "after a claim of two tickets pool:depth is %d and pool:15 holds %q: the counter must move by the tickets claimed", poolDepth(ctx), poolMembers(ctx));
  ctx.Equal(claimTickets("m-2", 15, {"t1"}), false, "t1 is already claimed");
  ctx.Equal(poolDepth(ctx), 1, "a refused claim must not move pool:depth");
  ctx.Equal(claimTickets("m-3", 15, {"t3"}), true, "claiming t3");
  ctx.Equal(poolDepth(ctx), 0, "after the last ticket was claimed, pool:depth");
}

void CheckCancelLeavesPool(harness::Ctx& ctx) {
  store::enqueue("t1", "p1", 1501, {"p1", "p2"});
  ctx.Redis.Set("open:p1", "t1");
  ctx.Redis.Set("open:p2", "t1");
  store::enqueue("t2", "p3", 1502, {"p3"});
  ctx.Redis.Set("open:p3", "t2");
  ctx.Equal(claimTickets("m-1", 15, {"t2"}), true, "claiming t2");
  ctx.Equal(cancelTicket("t1"), true, "cancelling the waiting ticket t1");
  ctx.Assert(!poolHas(ctx, "t1"), "the cancelled t1 still waits in pool:15 %q: the next matchmaker claims a ticket nobody is behind", poolMembers(ctx));
  ctx.Equal(poolDepth(ctx), static_cast<long>(poolMembers(ctx).size()), "after the cancel pool:depth must equal what waits in pool:15 %q; the depth", poolMembers(ctx));
  ctx.Equal(ctx.Redis.Exists("ticket:t1"), 0, "the cancelled ticket's hash must be gone");
  std::vector<std::string> left;
  for (const std::string k : {"open:p1", "open:p2"}) {
    if (ctx.Redis.Exists(k) == 1) left.push_back(k);
  }
  ctx.Assert(left.empty(), "%q still point at the cancelled ticket: those players cannot queue again until it expires", left);
  ctx.Equal(cancelTicket("t2"), false, "t2 is in match m-1: cancelling it must be refused");
  ctx.Assert(matchOf("t2") == "m-1" && ctx.Redis.Get("open:p3") == std::optional<std::string>("t2"), "a refused cancel changed t2 (match %s) or open:p3", matchOf("t2"));
}
`,
  },
  hints: [
    'Run two matchmakers over one pool with overlapping rosters: both claims answer true and one player holds two matches. After a refused claim, its first ticket is claimed by nobody who will ever start it.',
    'Each `HGET`, `ZREM` and `HSET` is its own round trip, so another matchmaker lands between them; the walk checks and writes ticket by ticket, so a refusal halfway leaves the first half written. Cancel touches the hash only.',
    'In one script, a first loop returns 0 on any ticket not `waiting`; a second loop `ZREM`s and `HSET`s; then `HINCRBY` depth by `-(#KEYS - 2)`. Cancel script: check `waiting`, `ZREM`, depth -1, `DEL` the open pointers holding the ticket.',
  ],
  debrief: `Redis runs a Lua script while every other client waits, so the script is the critical section: the checks and the writes have to sit inside it, and the checks have to come first, which is what makes a refusal free. Moving the depth counter in the same script is what keeps it equal to the pool, since no reader can see the pool changed and the counter not. Cancel needs the same treatment because it races the claim for the same ticket: a ticket that a matchmaker took a millisecond ago must not also be cancelled. Open Match does this with a pending state: tickets in a returned match leave queries until they are assigned or released. Larger systems shard pools by region and mode so one script never spans a hot key.`,
};
