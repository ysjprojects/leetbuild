import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis assignment leases and unread badges',
  concept: 'redis',
  file: 'state',
  focus: ['agent', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter is the Redis layer behind assignment and unread badges:
\`assign(ticket_id, agent)\` writes \`lease:{ticket_id}\` with a plain \`SET\` and returns the agent,
\`release(ticket_id, agent)\` deletes the key, and \`post_message(ticket_id, agent, body)\` appends the
note through \`store.append_note\`, then reads \`unread:{requester}\` with \`HGET\` and writes it back
plus one. With one agent at a time it works, and it hides 5 flaws.

**Failure mode the checks target.** Two agents answer the same customer, a ticket stays with an agent
who went home, one agent puts down a ticket another one holds, a released ticket never reappears in
the queue, and the customer's badge misses a reply.

- \`assign\` takes the lease in one \`SET lease:{ticket_id} {agent} NX EX LEASE_S\` (\`LEASE_S = 120\`)
  and returns the holder: the agent when it won, the current owner when it did not.
- An assigned ticket leaves \`assign:queue\` (\`ZREM\`). \`release\` deletes the lease only while
  \`agent\` holds it and puts the ticket back on \`assign:queue\` (\`ZADD\`, score now), in one Lua
  script, and returns whether it did.
- The badge moves with \`HINCRBY unread:{requester} {ticket_id} 1\`; \`post_message\` returns the new
  count.`,
  sequence: {
    participants: ['Agent', 'Ticket API', 'Redis'],
    messages: [
      {from: 'Agent', to: 'Ticket API', label: 'assign(T-1, A-1)', kind: 'sync'},
      {from: 'Ticket API', to: 'Redis', label: 'SET lease:T-1 A-1 NX EX 120', kind: 'sync'},
      {from: 'Redis', to: 'Ticket API', label: 'OK → ZREM assign:queue T-1 · nil → GET the holder', kind: 'reply'},
      {from: 'Agent', to: 'Ticket API', label: 'post_message(T-1, A-1, body)', kind: 'sync'},
      {from: 'Ticket API', to: 'Redis', label: 'HINCRBY unread:R-1 T-1 1', kind: 'sync'},
      {from: 'Agent', to: 'Ticket API', label: 'release(T-1, A-1)', kind: 'sync'},
      {from: 'Ticket API', to: 'Redis', label: 'EVAL: GET = A-1 ? DEL · ZADD assign:queue now T-1', kind: 'sync'},
      {from: 'Redis', to: 'Ticket API', label: '1 released · 0 not the holder', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'lease-exclusive',
      title: 'One agent holds a ticket at a time',
      detail:
        'The lease is taken with `SET … NX`, so a second agent’s assign leaves the holder in place and answers the holder; the starter’s plain `SET` hands the ticket to whoever asked last.',
      match: {
        python: {all: [/\.set\([^\n]*\bnx\s*=\s*True/]},
        typescript: {all: [/\.set\([^\n]*['"]NX['"]/]},
        go: {all: [/\.SetNX\(|Mode:\s*"NX"/]},
        scala: {all: [/\.nx\(\)/]},
        cpp: {all: [/UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'lease-expiry',
      title: 'A lease expires after 120 seconds',
      detail:
        'The same `SET` carries `EX LEASE_S` (120 s), so the ticket of an agent who crashed or went home comes back by itself; the starter’s lease never expires.',
      match: {
        python: {all: [/LEASE_S\s*=\s*120\b/, /\bex\s*=\s*LEASE_S/]},
        typescript: {all: [/LEASE_S\s*=\s*120\b/, /['"]EX['"],\s*LEASE_S/]},
        go: {all: [/leaseTTL\s*=\s*120\s*\*\s*time\.Second/, /SetNX\([^\n]*leaseTTL/]},
        scala: {all: [/LeaseSeconds\s*=\s*120L?\b/, /\.ex\(\s*LeaseSeconds/]},
        cpp: {all: [/kLeaseTTL\{120\}/, /\.set\([^;]*kLeaseTTL/]},
      },
    },
    {
      id: 'release-holder',
      title: 'Only the holder releases, in one script',
      detail:
        'Release compares the lease with the caller and deletes it in one Lua script (`GET` then `DEL` inside `EVAL`), so neither another agent nor a holder whose lease ran out can delete the lease someone else now holds; the starter deletes the key for anyone.',
      match: {
        python: {
          all: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]DEL['"]/, /\.eval\(|register_script\(/],
          none: [/\br\.delete\(/],
        },
        typescript: {
          all: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]DEL['"]/, /\.eval\(|defineCommand\(/],
          none: [/redis\.del\(/],
        },
        go: {
          all: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]DEL['"]/, /redis\.NewScript\(|\.Eval\(/],
          none: [/rdb\.Del\(/],
        },
        scala: {
          all: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]DEL['"]/, /jedis\.eval(sha)?\(/],
          none: [/jedis\.del\(/],
        },
        cpp: {
          all: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]DEL['"]/, /redis\.eval(sha)?[<(]/],
          none: [/redis\.del\(/],
        },
      },
    },
    {
      id: 'queue-return',
      title: 'Assignment takes the ticket off the queue, release puts it back',
      detail:
        'An assign that wins removes the ticket from `assign:queue` (`ZREM`) and a release adds it back (`ZADD`, score now), so the queue lists exactly the tickets nobody holds; the starter never touches the queue.',
      match: {
        python: {all: [/\.zrem\(/, /['"]ZADD['"]|\.zadd\(/]},
        typescript: {all: [/\.zrem\(/, /['"]ZADD['"]|\.zadd\(/]},
        go: {all: [/\.ZRem\(/, /['"]ZADD['"]|\.ZAdd\(/]},
        scala: {all: [/\.zrem\(/, /['"]ZADD['"]|\.zadd\(/]},
        cpp: {all: [/\.zrem\(/, /['"]ZADD['"]|\.zadd\(/]},
      },
    },
    {
      id: 'unread-atomic',
      title: 'The unread badge moves with HINCRBY',
      detail:
        'The requester’s badge for the ticket is incremented by Redis (`HINCRBY unread:{requester} {ticket_id} 1`), so two replies posted at once count twice; the starter reads the count, adds one and writes it back, and the second write erases the first.',
      match: {
        python: {all: [/\.hincrby\(/], none: [/\.hset\(/]},
        typescript: {all: [/\.hincrby\(/], none: [/\.hset\(/]},
        go: {all: [/\.HIncrBy\(/], none: [/rdb\.HSet\(/]},
        scala: {all: [/\.hincrBy\(/], none: [/jedis\.hset\(/]},
        cpp: {all: [/redis\.hincrby\(/], none: [/redis\.hset\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Assignment leases and unread badges."""
import redis

from tickets import store  # get_ticket, append_note

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def lease_key(ticket_id: str) -> str:
    return f"lease:{ticket_id}"


def unread_key(requester_id: str) -> str:
    return f"unread:{requester_id}"


def assign(ticket_id: str, agent: str) -> str:
    """Give the ticket to agent; returns the agent who holds it afterwards."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    r.set(lease_key(ticket_id), agent)
    return agent


def release(ticket_id: str, agent: str) -> bool:
    """agent puts the ticket down: True when it was theirs and is back on assign:queue."""
    r.delete(lease_key(ticket_id))
    return True


def post_message(ticket_id: str, agent: str, body: str) -> int:
    """An agent's reply on the ticket; returns the requester's unread count for it."""
    ticket = store.get_ticket(ticket_id)
    store.append_note(ticket_id, agent, "public", body)
    key = unread_key(ticket["requester_id"])
    count = int(r.hget(key, ticket_id) or 0) + 1
    r.hset(key, ticket_id, count)
    return count
`,
      solution: `"""Assignment leases and unread badges."""
import time

import redis

from tickets import store  # get_ticket, append_note

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_S = 120
QUEUE = "assign:queue"

# Deletes the lease only while ARGV[1] holds it, and puts the ticket (ARGV[3]) back on the queue at ARGV[2].
RELEASE_LUA = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
return 1
"""


def lease_key(ticket_id: str) -> str:
    return f"lease:{ticket_id}"


def unread_key(requester_id: str) -> str:
    return f"unread:{requester_id}"


def assign(ticket_id: str, agent: str) -> str:
    """Give the ticket to agent; returns the agent who holds it afterwards."""
    if r.set(lease_key(ticket_id), agent, nx=True, ex=LEASE_S):
        r.zrem(QUEUE, ticket_id)
        return agent
    return r.get(lease_key(ticket_id)) or ""


def release(ticket_id: str, agent: str) -> bool:
    """agent puts the ticket down: True when it was theirs and is back on assign:queue."""
    return r.eval(RELEASE_LUA, 2, lease_key(ticket_id), QUEUE, agent, int(time.time()), ticket_id) == 1


def post_message(ticket_id: str, agent: str, body: str) -> int:
    """An agent's reply on the ticket; returns the requester's unread count for it."""
    ticket = store.get_ticket(ticket_id)
    store.append_note(ticket_id, agent, "public", body)
    return r.hincrby(unread_key(ticket["requester_id"]), ticket_id, 1)
`,
    },
    typescript: {
      starter: `/** Assignment leases and unread badges. */
import Redis from 'ioredis';

import {appendNote, getTicket} from 'tickets/store';

const redis = new Redis({host: 'redis', port: 6379});

export const leaseKey = (ticketId: string): string => \`lease:\${ticketId}\`;
export const unreadKey = (requesterId: string): string => \`unread:\${requesterId}\`;

/** Give the ticket to agent; returns the agent who holds it afterwards. */
export async function assign(ticketId: string, agent: string): Promise<string> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  await redis.set(leaseKey(ticketId), agent);
  return agent;
}

/** agent puts the ticket down: true when it was theirs and is back on assign:queue. */
export async function release(ticketId: string, agent: string): Promise<boolean> {
  await redis.del(leaseKey(ticketId));
  return true;
}

/** An agent's reply on the ticket; returns the requester's unread count for it. */
export async function postMessage(ticketId: string, agent: string, body: string): Promise<number> {
  const ticket = await getTicket(ticketId);
  if (ticket === null) throw new Error(\`unknown ticket \${ticketId}\`);
  await appendNote(ticketId, agent, 'public', body);
  const key = unreadKey(ticket.requester_id);
  const count = Number((await redis.hget(key, ticketId)) ?? 0) + 1;
  await redis.hset(key, ticketId, count);
  return count;
}
`,
      solution: `/** Assignment leases and unread badges. */
import Redis from 'ioredis';

import {appendNote, getTicket} from 'tickets/store';

const redis = new Redis({host: 'redis', port: 6379});

export const LEASE_S = 120;
export const QUEUE = 'assign:queue';

/** Deletes the lease only while ARGV[1] holds it, and puts the ticket (ARGV[3]) back on the queue at ARGV[2]. */
export const RELEASE_LUA = \`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
return 1
\`;

export const leaseKey = (ticketId: string): string => \`lease:\${ticketId}\`;
export const unreadKey = (requesterId: string): string => \`unread:\${requesterId}\`;

/** Give the ticket to agent; returns the agent who holds it afterwards. */
export async function assign(ticketId: string, agent: string): Promise<string> {
  if ((await redis.set(leaseKey(ticketId), agent, 'EX', LEASE_S, 'NX')) === 'OK') {
    await redis.zrem(QUEUE, ticketId);
    return agent;
  }
  return (await redis.get(leaseKey(ticketId))) ?? '';
}

/** agent puts the ticket down: true when it was theirs and is back on assign:queue. */
export async function release(ticketId: string, agent: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  return (await redis.eval(RELEASE_LUA, 2, leaseKey(ticketId), QUEUE, agent, now, ticketId)) === 1;
}

/** An agent's reply on the ticket; returns the requester's unread count for it. */
export async function postMessage(ticketId: string, agent: string, body: string): Promise<number> {
  const ticket = await getTicket(ticketId);
  if (ticket === null) throw new Error(\`unknown ticket \${ticketId}\`);
  await appendNote(ticketId, agent, 'public', body);
  return redis.hincrby(unreadKey(ticket.requester_id), ticketId, 1);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"

	"tickets/store" // store.GetTicket, AppendNote
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func leaseKey(ticketID string) string { return "lease:" + ticketID }

func unreadKey(requesterID string) string { return "unread:" + requesterID }

// assign gives the ticket to agent; it returns the agent who holds it afterwards.
func assign(ctx context.Context, ticketID, agent string) (string, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	if err := rdb.Set(ctx, leaseKey(ticketID), agent, 0).Err(); err != nil {
		return "", err
	}
	return agent, nil
}

// release puts the ticket down: true when it was agent's and is back on assign:queue.
func release(ctx context.Context, ticketID, agent string) (bool, error) {
	if err := rdb.Del(ctx, leaseKey(ticketID)).Err(); err != nil {
		return false, err
	}
	return true, nil
}

// postMessage appends an agent's reply to the ticket and returns the requester's unread count for it.
func postMessage(ctx context.Context, ticketID, agent, body string) (int64, error) {
	ticket := store.GetTicket(ctx, ticketID)
	if ticket == nil {
		return 0, fmt.Errorf("unknown ticket %s", ticketID)
	}
	if _, err := store.AppendNote(ctx, ticketID, agent, "public", body); err != nil {
		return 0, err
	}
	key := unreadKey(ticket.RequesterID)
	count, _ := strconv.ParseInt(rdb.HGet(ctx, key, ticketID).Val(), 10, 64)
	count++
	if err := rdb.HSet(ctx, key, ticketID, count).Err(); err != nil {
		return 0, err
	}
	return count, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"tickets/store" // store.GetTicket, AppendNote
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	leaseTTL = 120 * time.Second
	queueKey = "assign:queue"
)

// releaseScript deletes the lease only while ARGV[1] holds it, and puts the ticket (ARGV[3]) back on the queue at ARGV[2].
var releaseScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
return 1
\`)

func leaseKey(ticketID string) string { return "lease:" + ticketID }

func unreadKey(requesterID string) string { return "unread:" + requesterID }

// assign gives the ticket to agent; it returns the agent who holds it afterwards.
func assign(ctx context.Context, ticketID, agent string) (string, error) {
	won, err := rdb.SetNX(ctx, leaseKey(ticketID), agent, leaseTTL).Result()
	if err != nil {
		return "", err
	}
	if won {
		return agent, rdb.ZRem(ctx, queueKey, ticketID).Err()
	}
	holder, err := rdb.Get(ctx, leaseKey(ticketID)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return holder, err
}

// release puts the ticket down: true when it was agent's and is back on assign:queue.
func release(ctx context.Context, ticketID, agent string) (bool, error) {
	released, err := releaseScript.Run(ctx, rdb, []string{leaseKey(ticketID), queueKey}, agent, time.Now().Unix(), ticketID).Int64()
	return released == 1, err
}

// postMessage appends an agent's reply to the ticket and returns the requester's unread count for it.
func postMessage(ctx context.Context, ticketID, agent, body string) (int64, error) {
	ticket := store.GetTicket(ctx, ticketID)
	if ticket == nil {
		return 0, fmt.Errorf("unknown ticket %s", ticketID)
	}
	if _, err := store.AppendNote(ctx, ticketID, agent, "public", body); err != nil {
		return 0, err
	}
	return rdb.HIncrBy(ctx, unreadKey(ticket.RequesterID), ticketID, 1).Result()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import tickets.Store // Store.getTicket, appendNote

object State {
  val jedis = new JedisPooled("redis", 6379)

  def leaseKey(ticketId: String): String = s"lease:$ticketId"
  def unreadKey(requesterId: String): String = s"unread:$requesterId"

  /** Give the ticket to agent; returns the agent who holds it afterwards. */
  def assign(ticketId: String, agent: String): String = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    jedis.set(leaseKey(ticketId), agent)
    agent
  }

  /** agent puts the ticket down: true when it was theirs and is back on assign:queue. */
  def release(ticketId: String, agent: String): Boolean = {
    jedis.del(leaseKey(ticketId))
    true
  }

  /** An agent's reply on the ticket; returns the requester's unread count for it. */
  def postMessage(ticketId: String, agent: String, body: String): Long = {
    val ticket = Store.getTicket(ticketId).getOrElse(throw new NoSuchElementException(s"unknown ticket $ticketId"))
    Store.appendNote(ticketId, agent, "public", body)
    val key = unreadKey(ticket.requesterId)
    val count = Option(jedis.hget(key, ticketId)).map(_.toLong).getOrElse(0L) + 1
    jedis.hset(key, ticketId, count.toString)
    count
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import tickets.Store // Store.getTicket, appendNote

object State {
  val jedis = new JedisPooled("redis", 6379)

  val LeaseSeconds = 120L
  val QueueKey = "assign:queue"

  /** Deletes the lease only while ARGV[1] holds it, and puts the ticket (ARGV[3]) back on the queue at ARGV[2]. */
  val ReleaseLua: String =
    """if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      |redis.call('DEL', KEYS[1])
      |redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
      |return 1
      |""".stripMargin

  def leaseKey(ticketId: String): String = s"lease:$ticketId"
  def unreadKey(requesterId: String): String = s"unread:$requesterId"

  /** Give the ticket to agent; returns the agent who holds it afterwards. */
  def assign(ticketId: String, agent: String): String =
    if (jedis.set(leaseKey(ticketId), agent, SetParams.setParams().nx().ex(LeaseSeconds)) == "OK") {
      jedis.zrem(QueueKey, ticketId)
      agent
    } else Option(jedis.get(leaseKey(ticketId))).getOrElse("")

  /** agent puts the ticket down: true when it was theirs and is back on assign:queue. */
  def release(ticketId: String, agent: String): Boolean = {
    val args = List(agent, (System.currentTimeMillis() / 1000).toString, ticketId)
    jedis.eval(ReleaseLua, List(leaseKey(ticketId), QueueKey).asJava, args.asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** An agent's reply on the ticket; returns the requester's unread count for it. */
  def postMessage(ticketId: String, agent: String, body: String): Long = {
    val ticket = Store.getTicket(ticketId).getOrElse(throw new NoSuchElementException(s"unknown ticket $ticketId"))
    Store.appendNote(ticketId, agent, "public", body)
    jedis.hincrBy(unreadKey(ticket.requesterId), ticketId, 1L)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>

#include "tickets/store.h"  // store::getTicket, appendNote

sw::redis::Redis redis("tcp://redis:6379");

std::string leaseKey(const std::string& ticket_id) { return "lease:" + ticket_id; }

std::string unreadKey(const std::string& requester_id) { return "unread:" + requester_id; }

// Give the ticket to agent; returns the agent who holds it afterwards.
std::string assign(const std::string& ticket_id, const std::string& agent) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  redis.set(leaseKey(ticket_id), agent);
  return agent;
}

// agent puts the ticket down: true when it was theirs and is back on assign:queue.
bool release(const std::string& ticket_id, const std::string& agent) {
  redis.del(leaseKey(ticket_id));
  return true;
}

// An agent's reply on the ticket; returns the requester's unread count for it.
long long postMessage(const std::string& ticket_id, const std::string& agent, const std::string& body) {
  const auto ticket = store::getTicket(ticket_id);
  if (!ticket) throw std::out_of_range("unknown ticket " + ticket_id);
  store::appendNote(ticket_id, agent, "public", body);
  const std::string key = unreadKey(ticket->requester_id);
  const auto current = redis.hget(key, ticket_id);
  const long long count = (current ? std::stoll(*current) : 0) + 1;
  redis.hset(key, ticket_id, std::to_string(count));
  return count;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "tickets/store.h"  // store::getTicket, appendNote

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kLeaseTTL{120};
const std::string kQueueKey = "assign:queue";

// Deletes the lease only while ARGV[1] holds it, and puts the ticket (ARGV[3]) back on the queue at ARGV[2].
const std::string kReleaseLua = R"lua(
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
return 1
)lua";

std::string leaseKey(const std::string& ticket_id) { return "lease:" + ticket_id; }

std::string unreadKey(const std::string& requester_id) { return "unread:" + requester_id; }

// Give the ticket to agent; returns the agent who holds it afterwards.
std::string assign(const std::string& ticket_id, const std::string& agent) {
  if (redis.set(leaseKey(ticket_id), agent, kLeaseTTL, sw::redis::UpdateType::NOT_EXIST)) {
    redis.zrem(kQueueKey, ticket_id);
    return agent;
  }
  return redis.get(leaseKey(ticket_id)).value_or("");
}

// agent puts the ticket down: true when it was theirs and is back on assign:queue.
bool release(const std::string& ticket_id, const std::string& agent) {
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  return redis.eval<long long>(kReleaseLua, {leaseKey(ticket_id), kQueueKey}, {agent, std::to_string(now), ticket_id}) == 1;
}

// An agent's reply on the ticket; returns the requester's unread count for it.
long long postMessage(const std::string& ticket_id, const std::string& agent, const std::string& body) {
  const auto ticket = store::getTicket(ticket_id);
  if (!ticket) throw std::out_of_range("unknown ticket " + ticket_id);
  store::appendNote(ticket_id, agent, "public", body);
  return redis.hincrby(unreadKey(ticket->requester_id), ticket_id, 1);
}
`,
    },
  },
  harness: {
    python: `from tickets import store

QUEUE = "assign:queue"


def _state(ctx):
    m = ctx.load("state")
    return m, store.create_ticket("R-1", "Printer on fire")["id"]


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_lease_exclusive(ctx):
    m, t = _state(ctx)
    lease = f"lease:{t}"
    assert m.assign(t, "A-1") == "A-1", "a free ticket must go to the first agent who asks"
    second = m.assign(t, "A-2")
    assert second == "A-1", f"a second agent's assign answered {second!r}: the ticket is A-1's, so assign must answer its holder"
    assert ctx.redis.get(lease) == "A-1", f"{lease} is {ctx.redis.get(lease)!r}: the second assign took the lease from A-1 and both agents now answer the customer"
    # Two agents click Assign on another ticket at the same instant.
    t2 = store.create_ticket("R-1", "Second printer on fire")["id"]
    rival = ctx.redis_after(f"lease:{t2}", lambda: ctx.redis.set(f"lease:{t2}", "A-2", nx=True, ex=120))
    mine = m.assign(t2, "A-1")
    rival_won = bool(_settled(rival, f"lease:{t2}"))
    owners = (["A-1"] if mine == "A-1" else []) + (["A-2"] if rival_won else [])
    assert len(owners) == 1, f"two agents assigning {t2} at once: A-1's assign answered {mine!r} and A-2's SET NX {'won' if rival_won else 'lost'}, so {len(owners)} agents own it. Take the lease in one SET NX"
    assert ctx.redis.get(f"lease:{t2}") == owners[0], f"lease:{t2} is {ctx.redis.get(f'lease:{t2}')!r}, but {owners[0]} owns the ticket"


def check_lease_expiry(ctx):
    m, t = _state(ctx)
    lease = f"lease:{t}"
    m.assign(t, "A-1")
    ttl = ctx.redis.ttl(lease)
    assert 0 < ttl <= 120, f"{lease} has TTL {ttl}: a lease must expire after LEASE_S = 120 s, or the ticket of an agent who went home stays theirs"
    ctx.clock.advance(121)
    got = m.assign(t, "A-2")
    assert got == "A-2", f"121 s after A-1 took the lease and went silent, A-2's assign answered {got!r}: the lease must have expired"


def check_release_holder(ctx):
    m, t = _state(ctx)
    lease = f"lease:{t}"
    m.assign(t, "A-1")
    assert m.release(t, "A-2") is False, "A-2 released A-1's ticket: only the lease's holder may release it, and release must answer False"
    assert ctx.redis.get(lease) == "A-1", f"{lease} is {ctx.redis.get(lease)!r} after A-2's release, expected A-1 to keep it"

    # A-1's lease runs out while its release is in flight, and A-2 takes the ticket.
    def expire_and_take():
        ctx.redis.delete(lease)
        return ctx.redis.set(lease, "A-2", nx=True, ex=120)

    rival = ctx.redis_after(lease, expire_and_take)
    m.release(t, "A-1")
    _settled(rival, lease)
    assert ctx.redis.get(lease) == "A-2", f"after A-1's late release {lease} is {ctx.redis.get(lease)!r}: A-1 deleted the lease A-2 had just taken. Compare the holder and delete in one script"


def check_queue_return(ctx):
    m, t = _state(ctx)
    lease = f"lease:{t}"
    ctx.redis.zadd(QUEUE, {t: 1})
    m.assign(t, "A-1")
    assert ctx.redis.zscore(QUEUE, t) is None, f"{t} is still on {QUEUE} after A-1 took it: the next agent would pick it up too"
    assert m.release(t, "A-1") is True, "the holder's release must answer True"
    assert ctx.redis.exists(lease) == 0, f"{lease} is still there after its holder released it"
    assert ctx.redis.zscore(QUEUE, t) is not None, f"{t} is not on {QUEUE} after its release: a ticket nobody holds must be back in the queue"
    assert m.assign(t, "A-2") == "A-2", "a released ticket must go to the next agent who asks"


def check_unread_atomic(ctx):
    m, t = _state(ctx)
    key = "unread:R-1"
    # Another replica posts a reply on the same ticket the instant this post first touches the badge.
    rival = ctx.redis_after(key, lambda: ctx.redis.hincrby(key, t, 1))
    m.post_message(t, "A-1", "We refunded the second charge.")
    _settled(rival, key)
    count = ctx.redis.hget(key, t)
    assert count == "2", f"two replies were posted on {t} and the badge reads {count!r}: one increment was lost between a read and a write. Increment with HINCRBY"
    bodies = [n["body"] for n in store.page(t, None, 10)]
    assert bodies == ["We refunded the second charge."], f"post_message must append the reply as a note, the ticket has {bodies}"
`,
    typescript: `const QUEUE = 'assign:queue';

async function state(ctx) {
  const m = ctx.load('state');
  const store = ctx.load('/support/tickets/store.ts');
  const t = (await store.createTicket('R-1', 'Printer on fire')).id;
  return {m, store, t};
}

function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return probe.result;
}

export async function check_lease_exclusive(ctx) {
  const {m, store, t} = await state(ctx);
  const lease = \`lease:\${t}\`;
  assert.equal(await m.assign(t, 'A-1'), 'A-1', 'a free ticket must go to the first agent who asks');
  const second = await m.assign(t, 'A-2');
  assert.equal(second, 'A-1', \`a second agent's assign answered \${JSON.stringify(second)}: the ticket is A-1's, so assign must answer its holder\`);
  assert.equal(ctx.redis.get(lease), 'A-1', \`\${lease} is \${JSON.stringify(ctx.redis.get(lease))}: the second assign took the lease from A-1 and both agents now answer the customer\`);
  // Two agents click Assign on another ticket at the same instant.
  const t2 = (await store.createTicket('R-1', 'Second printer on fire')).id;
  const rival = ctx.redisAfter(\`lease:\${t2}\`, () => ctx.redis.set(\`lease:\${t2}\`, 'A-2', 'NX', 'EX', 120));
  const mine = await m.assign(t2, 'A-1');
  const rivalWon = settled(rival, \`lease:\${t2}\`) === 'OK';
  const owners = [...(mine === 'A-1' ? ['A-1'] : []), ...(rivalWon ? ['A-2'] : [])];
  assert.equal(owners.length, 1, \`two agents assigning \${t2} at once: A-1's assign answered \${JSON.stringify(mine)} and A-2's SET NX \${rivalWon ? 'won' : 'lost'}, so \${owners.length} agents own it. Take the lease in one SET NX\`);
  assert.equal(ctx.redis.get(\`lease:\${t2}\`), owners[0], \`lease:\${t2} must name the one owner, \${owners[0]}\`);
}

export async function check_lease_expiry(ctx) {
  const {m, t} = await state(ctx);
  const lease = \`lease:\${t}\`;
  await m.assign(t, 'A-1');
  const ttl = ctx.redis.ttl(lease);
  assert(ttl > 0 && ttl <= 120, \`\${lease} has TTL \${ttl}: a lease must expire after LEASE_S = 120 s, or the ticket of an agent who went home stays theirs\`);
  ctx.clock.advance(121);
  const got = await m.assign(t, 'A-2');
  assert.equal(got, 'A-2', \`121 s after A-1 took the lease and went silent, A-2's assign answered \${JSON.stringify(got)}: the lease must have expired\`);
}

export async function check_release_holder(ctx) {
  const {m, t} = await state(ctx);
  const lease = \`lease:\${t}\`;
  await m.assign(t, 'A-1');
  assert.equal(await m.release(t, 'A-2'), false, "A-2 released A-1's ticket: only the lease's holder may release it, and release must answer false");
  assert.equal(ctx.redis.get(lease), 'A-1', \`\${lease} is \${JSON.stringify(ctx.redis.get(lease))} after A-2's release, expected A-1 to keep it\`);
  // A-1's lease runs out while its release is in flight, and A-2 takes the ticket.
  const rival = ctx.redisAfter(lease, () => {
    ctx.redis.del(lease);
    return ctx.redis.set(lease, 'A-2', 'NX', 'EX', 120);
  });
  await m.release(t, 'A-1');
  settled(rival, lease);
  assert.equal(ctx.redis.get(lease), 'A-2', \`after A-1's late release \${lease} is \${JSON.stringify(ctx.redis.get(lease))}: A-1 deleted the lease A-2 had just taken. Compare the holder and delete in one script\`);
}

export async function check_queue_return(ctx) {
  const {m, t} = await state(ctx);
  const lease = \`lease:\${t}\`;
  ctx.redis.zadd(QUEUE, 1, t);
  await m.assign(t, 'A-1');
  assert.equal(ctx.redis.zscore(QUEUE, t), null, \`\${t} is still on \${QUEUE} after A-1 took it: the next agent would pick it up too\`);
  assert.equal(await m.release(t, 'A-1'), true, "the holder's release must answer true");
  assert.equal(ctx.redis.exists(lease), 0, \`\${lease} is still there after its holder released it\`);
  assert.notEqual(ctx.redis.zscore(QUEUE, t), null, \`\${t} is not on \${QUEUE} after its release: a ticket nobody holds must be back in the queue\`);
  assert.equal(await m.assign(t, 'A-2'), 'A-2', 'a released ticket must go to the next agent who asks');
}

export async function check_unread_atomic(ctx) {
  const {m, store, t} = await state(ctx);
  const key = 'unread:R-1';
  // Another replica posts a reply on the same ticket the instant this post first touches the badge.
  const rival = ctx.redisAfter(key, () => ctx.redis.hincrby(key, t, 1));
  await m.postMessage(t, 'A-1', 'We refunded the second charge.');
  settled(rival, key);
  const count = ctx.redis.hget(key, t);
  assert.equal(count, '2', \`two replies were posted on \${t} and the badge reads \${JSON.stringify(count)}: one increment was lost between a read and a write. Increment with HINCRBY\`);
  const bodies = (await store.page(t, null, 10)).map(n => n.body);
  assert.deepStrictEqual(bodies, ['We refunded the second charge.'], \`postMessage must append the reply as a note, the ticket has \${JSON.stringify(bodies)}\`);
}
`,
    go: `package main

import (
	"context"

	"tickets/store"

	"leetbuild/harness"
)

const stateQueue = "assign:queue"

var stateBg = context.Background()

func stateTicket(subject string) string { return store.CreateTicket(stateBg, "R-1", subject).ID }

func stateAssign(ctx *harness.Ctx, ticketID, agent string) string {
	holder, err := assign(stateBg, ticketID, agent)
	ctx.NoError(err, "assign(%s, %s) failed", ticketID, agent)
	return holder
}

func stateRelease(ctx *harness.Ctx, ticketID, agent string) bool {
	released, err := release(stateBg, ticketID, agent)
	ctx.NoError(err, "release(%s, %s) failed", ticketID, agent)
	return released
}

func stateLease(ctx *harness.Ctx, ticketID string) string {
	holder, _ := ctx.Redis.Get("lease:" + ticketID)
	return holder
}

func CheckLeaseExclusive(ctx *harness.Ctx) {
	t := stateTicket("Printer on fire")
	ctx.Equal(stateAssign(ctx, t, "A-1"), "A-1", "a free ticket must go to the first agent who asks; assign answered")
	ctx.Equal(stateAssign(ctx, t, "A-2"), "A-1", "the ticket is A-1's, so a second agent's assign must answer its holder; it answered")
	ctx.Equal(stateLease(ctx, t), "A-1", "lease:%s after a second agent's assign (taking it from A-1 means both agents answer the customer)", t)
	// Two agents click Assign on another ticket at the same instant.
	t2 := stateTicket("Second printer on fire")
	rival := ctx.Redis.After("lease:"+t2, func() any { return ctx.Redis.Set("lease:"+t2, "A-2", "NX", "EX", 120) })
	mine := stateAssign(ctx, t2, "A-1")
	ctx.Assert(rival.Fired, "nothing touched lease:%s", t2)
	rivalWon := rival.Result == true
	var owners []string
	if mine == "A-1" {
		owners = append(owners, "A-1")
	}
	if rivalWon {
		owners = append(owners, "A-2")
	}
	ctx.Assert(len(owners) == 1, "two agents assigning %s at once: A-1's assign answered %q and A-2's SET NX won=%t, so %d agents own it. Take the lease in one SET NX", t2, mine, rivalWon, len(owners))
	ctx.Equal(stateLease(ctx, t2), owners[0], "lease:%s must name the one owner", t2)
}

func CheckLeaseExpiry(ctx *harness.Ctx) {
	t := stateTicket("Printer on fire")
	stateAssign(ctx, t, "A-1")
	ttl := ctx.Redis.TTL("lease:" + t)
	ctx.Assert(ttl > 0 && ttl <= 120, "lease:%s has TTL %d: a lease must expire after leaseTTL = 120 s, or the ticket of an agent who went home stays theirs", t, ttl)
	ctx.Clock.Advance(121)
	ctx.Equal(stateAssign(ctx, t, "A-2"), "A-2", "121 s after A-1 took the lease and went silent, the lease must have expired; A-2's assign answered")
}

func CheckReleaseHolder(ctx *harness.Ctx) {
	t := stateTicket("Printer on fire")
	lease := "lease:" + t
	stateAssign(ctx, t, "A-1")
	ctx.Equal(stateRelease(ctx, t, "A-2"), false, "A-2 released A-1's ticket: only the lease's holder may release it; release answered")
	ctx.Equal(stateLease(ctx, t), "A-1", "%s after A-2's release (A-1 must keep it)", lease)
	// A-1's lease runs out while its release is in flight, and A-2 takes the ticket.
	rival := ctx.Redis.After(lease, func() any {
		ctx.Redis.Del(lease)
		return ctx.Redis.Set(lease, "A-2", "NX", "EX", 120)
	})
	stateRelease(ctx, t, "A-1")
	ctx.Assert(rival.Fired, "nothing touched %s", lease)
	ctx.Equal(stateLease(ctx, t), "A-2", "after A-1's late release, %s (A-1 deleted the lease A-2 had just taken: compare the holder and delete in one script)", lease)
}

func CheckQueueReturn(ctx *harness.Ctx) {
	t := stateTicket("Printer on fire")
	ctx.Redis.Do("ZADD", stateQueue, 1, t)
	stateAssign(ctx, t, "A-1")
	_, queued := ctx.Redis.ZScore(stateQueue, t)
	ctx.Assert(!queued, "%s is still on %s after A-1 took it: the next agent would pick it up too", t, stateQueue)
	ctx.Equal(stateRelease(ctx, t, "A-1"), true, "the holder's release; it answered")
	ctx.Equal(ctx.Redis.Exists("lease:"+t), int64(0), "lease:%s after its holder released it; exists", t)
	_, queued = ctx.Redis.ZScore(stateQueue, t)
	ctx.Assert(queued, "%s is not on %s after its release: a ticket nobody holds must be back in the queue", t, stateQueue)
	ctx.Equal(stateAssign(ctx, t, "A-2"), "A-2", "a released ticket must go to the next agent who asks; assign answered")
}

func CheckUnreadAtomic(ctx *harness.Ctx) {
	t := stateTicket("Printer on fire")
	key := "unread:R-1"
	// Another replica posts a reply on the same ticket the instant this post first touches the badge.
	rival := ctx.Redis.After(key, func() any { return ctx.Redis.Do("HINCRBY", key, t, 1) })
	_, err := postMessage(stateBg, t, "A-1", "We refunded the second charge.")
	ctx.NoError(err, "postMessage failed")
	ctx.Assert(rival.Fired, "postMessage never touched %s", key)
	count, _ := ctx.Redis.HGet(key, t)
	ctx.Equal(count, "2", "two replies were posted on %s: one increment was lost between a read and a write (increment with HINCRBY); the badge", t)
	notes := store.Page(stateBg, t, 0, 10)
	ctx.Assert(len(notes) == 1 && notes[0].Body == "We refunded the second charge.", "postMessage must append the reply as a note, the ticket has %+v", notes)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "tickets/store.h"

namespace {

const std::string kQueue = "assign:queue";

std::string newTicket(const std::string& subject) { return store::createTicket("R-1", subject).id; }

std::string leaseOf(harness::Ctx& ctx, const std::string& ticket_id) {
  return ctx.Redis.Get("lease:" + ticket_id).value_or("");
}

// What a parallel call did: whether it ran and what it answered.
struct Rival {
  bool fired = false;
  bool won = false;
};

}  // namespace

void CheckLeaseExclusive(harness::Ctx& ctx) {
  const std::string t = newTicket("Printer on fire");
  ctx.Equal(assign(t, "A-1"), "A-1", "a free ticket must go to the first agent who asks; assign answered");
  ctx.Equal(assign(t, "A-2"), "A-1", "the ticket is A-1's, so a second agent's assign must answer its holder; it answered");
  ctx.Equal(leaseOf(ctx, t), "A-1", "lease:%s after a second agent's assign (taking it from A-1 means both agents answer the customer)", t);
  // Two agents click Assign on another ticket at the same instant.
  const std::string t2 = newTicket("Second printer on fire");
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After("lease:" + t2, [&ctx, rival, t2] {
    rival->fired = true;
    rival->won = ctx.Redis.Set("lease:" + t2, "A-2", "NX", "EX", 120);
  });
  const std::string mine = assign(t2, "A-1");
  ctx.Assert(rival->fired, "nothing touched lease:%s", t2);
  std::vector<std::string> owners;
  if (mine == "A-1") owners.push_back("A-1");
  if (rival->won) owners.push_back("A-2");
  ctx.Assert(owners.size() == 1, "two agents assigning %s at once: A-1's assign answered %q and A-2's SET NX won=%t, so %d agents own it. Take the lease in one SET NX", t2, mine, rival->won, owners.size());
  ctx.Equal(leaseOf(ctx, t2), owners[0], "lease:%s must name the one owner", t2);
}

void CheckLeaseExpiry(harness::Ctx& ctx) {
  const std::string t = newTicket("Printer on fire");
  assign(t, "A-1");
  const long long ttl = ctx.Redis.TTL("lease:" + t);
  ctx.Assert(ttl > 0 && ttl <= 120, "lease:%s has TTL %d: a lease must expire after kLeaseTTL = 120 s, or the ticket of an agent who went home stays theirs", t, ttl);
  ctx.Clock.Advance(121);
  ctx.Equal(assign(t, "A-2"), "A-2", "121 s after A-1 took the lease and went silent, the lease must have expired; A-2's assign answered");
}

void CheckReleaseHolder(harness::Ctx& ctx) {
  const std::string t = newTicket("Printer on fire");
  const std::string lease = "lease:" + t;
  assign(t, "A-1");
  ctx.Equal(release(t, "A-2"), false, "A-2 released A-1's ticket: only the lease's holder may release it; release answered");
  ctx.Equal(leaseOf(ctx, t), "A-1", "%s after A-2's release (A-1 must keep it)", lease);
  // A-1's lease runs out while its release is in flight, and A-2 takes the ticket.
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After(lease, [&ctx, rival, lease] {
    rival->fired = true;
    ctx.Redis.Del(lease);
    rival->won = ctx.Redis.Set(lease, "A-2", "NX", "EX", 120);
  });
  release(t, "A-1");
  ctx.Assert(rival->fired, "nothing touched %s", lease);
  ctx.Equal(leaseOf(ctx, t), "A-2", "after A-1's late release, %s (A-1 deleted the lease A-2 had just taken: compare the holder and delete in one script)", lease);
}

void CheckQueueReturn(harness::Ctx& ctx) {
  const std::string t = newTicket("Printer on fire");
  ctx.Redis.Do("ZADD", kQueue, 1, t);
  assign(t, "A-1");
  ctx.Assert(!ctx.Redis.ZScore(kQueue, t).has_value(), "%s is still on %s after A-1 took it: the next agent would pick it up too", t, kQueue);
  ctx.Equal(release(t, "A-1"), true, "the holder's release; it answered");
  ctx.Equal(ctx.Redis.Exists("lease:" + t), 0, "lease:%s after its holder released it; exists", t);
  ctx.Assert(ctx.Redis.ZScore(kQueue, t).has_value(), "%s is not on %s after its release: a ticket nobody holds must be back in the queue", t, kQueue);
  ctx.Equal(assign(t, "A-2"), "A-2", "a released ticket must go to the next agent who asks; assign answered");
}

void CheckUnreadAtomic(harness::Ctx& ctx) {
  const std::string t = newTicket("Printer on fire");
  const std::string key = "unread:R-1";
  // Another replica posts a reply on the same ticket the instant this post first touches the badge.
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After(key, [&ctx, rival, key, t] {
    rival->fired = true;
    ctx.Redis.Do("HINCRBY", key, t, 1);
  });
  postMessage(t, "A-1", "We refunded the second charge.");
  ctx.Assert(rival->fired, "postMessage never touched %s", key);
  ctx.Equal(ctx.Redis.HGet(key, t).value_or(""), "2", "two replies were posted on %s: one increment was lost between a read and a write (increment with HINCRBY); the badge", t);
  const auto notes = store::page(t, 0, 10);
  ctx.Assert(notes.size() == 1 && notes[0].body == "We refunded the second charge.", "postMessage must append the reply as a note, the ticket has %d notes", notes.size());
}
`,
  },
  hints: [
    'Assign one ticket to A-1, then to A-2: both calls answer their own name. Release it as A-2 while A-1 holds it: it is released. Post two replies at once: the customer’s badge says one.',
    'A plain `SET` overwrites whoever holds the key and never expires; `DEL` does not ask whose lease it deletes; `HGET` then `HSET` lets a second writer land between the read and the write.',
    '`set(lease, agent, nx=True, ex=LEASE_S)`, on success `ZREM assign:queue`, else answer `GET`. Release in one script: `GET` = agent ? `DEL` + `ZADD assign:queue now ticket` : 0. Count with `HINCRBY`.',
  ],
  debrief: `A lease is the smallest correct shape for "one owner at a time": \`NX\` makes the take a single decision Redis arbitrates, and \`EX\` turns a crashed agent into a ticket that comes back by itself. The release has to be one script because a holder's check and its delete are two moments, and the lease can change hands between them; inside \`EVAL\` there is no between. \`HINCRBY\` is the same idea for the badge: the server adds, so two writers cannot erase each other. Production assignment adds a heartbeat that renews the lease while the agent is active, a fencing token on every write so a holder whose lease expired cannot still commit, and a sweeper that requeues tickets whose lease ran out.`,
};
