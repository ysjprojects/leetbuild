import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis pool buckets with atomic claims',
  concept: 'redis',
  file: 'state',
  focus: ['matchmaker', 'redis'],
  task: `## Task

**Starting point.** The starter is the pool module the matchmaker calls when it forms a match.
\`claim_participants(match_id, bucket, ticket_ids)\` loops over the roster and, per ticket, tests
the claimed marker, \`ZREM\`s the ticket from its bucket, sets the marker to the match id and
decrements the depth counter; \`cancel_ticket(ticket_id, bucket, skill)\` deletes the open-ticket
pointer. It compiles, passes the single-threaded demo and hides 5 flaws.

**Failure mode the checks target.** Two matchmakers, one pool, one player claimed twice: each
command in the loop is a window for the other instance. A refused claim returns after some tickets
were already removed and marked, the depth counter drifts with the partial loop, and a cancelled
ticket ends up in neither the pool nor the claimed set.

- Claim **every** participant ticket in **one atomic Lua \`EVAL\`**: test every claimed marker
  first; if any is set, return **0** without touching the pool and the caller gets \`false\`.
- Only once the whole roster is free, \`ZREM\` each ticket from its bucket and set its marker in
  the same script, so no other matchmaker can see a claimed ticket.
- The script moves \`{DEPTH_KEY}:{bucket}\` with \`HINCRBY\` by the number of tickets it removes;
  \`cancel_ticket\` moves it back up.
- \`cancel_ticket\` runs its own script: \`ZADD\` the ticket back at its skill, restore the depth
  counter and clear the claimed marker.`,
  sequence: {
    participants: ['Matchmaker', 'Redis pools'],
    messages: [
      {
        from: 'Matchmaker',
        to: 'Redis pools',
        label: 'EVAL claim.lua 3 claimed · pool · depth · N · tickets · match_id',
        kind: 'sync',
      },
      {from: 'Redis pools', to: 'Matchmaker', label: '0 already claimed / 1 claimed', kind: 'reply'},
      {from: 'Redis pools', to: 'Redis pools', label: 'ZREM pool:{bucket} ticket · SET claimed:{ticket}', kind: 'sync'},
      {from: 'Redis pools', to: 'Redis pools', label: 'HINCRBY depth -N', kind: 'sync'},
      {from: 'Matchmaker', to: 'Redis pools', label: 'EVAL cancel.lua 3 pool · depth · claimed', kind: 'sync'},
      {
        from: 'Redis pools',
        to: 'Redis pools',
        label: 'ZADD pool:{bucket} · HINCRBY depth +1 · DEL claimed',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'Claims the whole roster in one atomic script',
      detail:
        'Every participant ticket is claimed by one `EVAL`/`NewScript` run. The starter checks and claims one ticket at a time, so a concurrent matchmaker can claim an overlapping ticket between two of its commands.',
      match: {
        python: {all: [/CLAIM_LUA/, /\.eval\(/]},
        typescript: {all: [/CLAIM_LUA/, /\.eval\(/]},
        go: {all: [/claimScript/, /\.Run\(/]},
        scala: {all: [/ClaimLua/, /jedis\.eval\(/]},
        cpp: {all: [/CLAIM_LUA/, /eval/]},
      },
    },
    {
      id: 'all-or-nothing',
      title: 'Claims every participant or none',
      detail:
        'The script tests the claimed markers first and returns **0** without touching the pool when any ticket is already claimed, so a half-claimed roster is impossible. The starter returns after removing some tickets, leaving those tickets claimed by a match that will never form.',
      match: {
        python: {all: [/CLAIMED_PREFIX/, /return 0/]},
        typescript: {all: [/CLAIMED_PREFIX/, /return 0/]},
        go: {all: [/claimedPrefix/, /return 0/]},
        scala: {all: [/ClaimedPrefix/, /return 0/]},
        cpp: {all: [/kClaimedPrefix/, /return 0/]},
      },
    },
    {
      id: 'invisible-claim',
      title: 'Claimed tickets leave the pool',
      detail:
        'The script `ZREM`s each ticket from its bucket as it marks it claimed, so another matchmaker scanning the bucket can never see a ticket that is already in a match. The starter leaves claimed tickets in the bucket.',
      match: {
        python: {all: [/ZREM/]},
        typescript: {all: [/ZREM/]},
        go: {all: [/ZREM/]},
        scala: {all: [/ZREM/]},
        cpp: {all: [/ZREM/]},
      },
    },
    {
      id: 'depth-counters',
      title: 'Pool depth counters track the ticket set',
      detail:
        'The same script moves the depth counter `HINCRBY depth -N` when it removes tickets, and the cancel path moves it back, so `{DEPTH_KEY}:{bucket}` always equals the tickets still waiting. The starter updates the counter outside the claim, so a refused or cancelled ticket leaves it wrong.',
      match: {
        python: {all: [/HINCRBY/, /depth/]},
        typescript: {all: [/HINCRBY/, /depth/]},
        go: {all: [/HINCRBY/, /depth/]},
        scala: {all: [/HINCRBY/, /depth/]},
        cpp: {all: [/HINCRBY/, /depth/]},
      },
    },
    {
      id: 'cancel-releases',
      title: 'Cancellation returns the ticket to the pool',
      detail:
        '`cancel_ticket` `ZADD`s the ticket back into its bucket at its skill, restores the depth counter and clears the claimed marker — so the ticket can be matched again. The starter deletes the open-ticket pointer only and leaves a ghost.',
      match: {
        python: {all: [/CANCEL_LUA/, /ZADD/]},
        typescript: {all: [/CANCEL_LUA/, /ZADD/]},
        go: {all: [/cancelScript/, /ZADD/]},
        scala: {all: [/CancelLua/, /ZADD/]},
        cpp: {all: [/CANCEL_LUA/, /ZADD/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis as redis_lib

BUCKET_PREFIX = "matchmaking:pool"
DEPTH_KEY = "matchmaking:depth"
CLAIMED_PREFIX = "matchmaking:claimed"


def bucket_key(bucket: int) -> str:
    return f"{BUCKET_PREFIX}:{bucket}"


def depth_key(bucket: int) -> str:
    return f"{DEPTH_KEY}:{bucket}"


def claimed_key(ticket_id: str) -> str:
    return f"{CLAIMED_PREFIX}:{ticket_id}"


def claim_participants(r: redis_lib.Redis, match_id: str, bucket: int, ticket_ids: list[str]) -> bool:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    for ticket_id in ticket_ids:
        if r.exists(claimed_key(ticket_id)):
            return False
        r.zrem(bucket_key(bucket), ticket_id)
        r.set(claimed_key(ticket_id), match_id)
        r.hincrby(depth_key(bucket), "waiting", -1)
    return True


def cancel_ticket(r: redis_lib.Redis, ticket_id: str, bucket: int, skill: float) -> None:
    r.delete(f"matchmaking:open:{ticket_id}")
`,
      solution: `import redis as redis_lib

BUCKET_PREFIX = "matchmaking:pool"
DEPTH_KEY = "matchmaking:depth"
CLAIMED_PREFIX = "matchmaking:claimed"

CLAIM_LUA = """
local claimed = KEYS[1]
local bucket = KEYS[2]
local depth = KEYS[3]
local count = tonumber(ARGV[1])
for i = 1, count do
  local ticket = ARGV[i + 1]
  if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
    return 0
  end
end
for i = 1, count do
  local ticket = ARGV[i + 1]
  redis.call('ZREM', bucket, ticket)
  redis.call('SET', claimed .. ':' .. ticket, ARGV[count + 2])
end
redis.call('HINCRBY', depth, 0 - count)
return 1
"""

CANCEL_LUA = """
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local ticket = ARGV[1]
local skill = tonumber(ARGV[2])
if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('HINCRBY', depth, 1)
  redis.call('DEL', claimed .. ':' .. ticket)
end
return 1
"""


def bucket_key(bucket: int) -> str:
    return f"{BUCKET_PREFIX}:{bucket}"


def depth_key(bucket: int) -> str:
    return f"{DEPTH_KEY}:{bucket}"


def claim_participants(r: redis_lib.Redis, match_id: str, bucket: int, ticket_ids: list[str]) -> bool:
    args = [len(ticket_ids), *ticket_ids, match_id]
    claimed = r.eval(CLAIM_LUA, 3, CLAIMED_PREFIX, bucket_key(bucket), depth_key(bucket), *args)
    return bool(claimed)


def cancel_ticket(r: redis_lib.Redis, ticket_id: str, bucket: int, skill: float) -> None:
    r.eval(CANCEL_LUA, 3, bucket_key(bucket), depth_key(bucket), CLAIMED_PREFIX, ticket_id, skill)
`,
    },
    typescript: {
      starter: `/** Pool state: claim and cancel tickets. */
import {Redis} from 'ioredis';

export const r = new Redis('redis://redis:6379');

const BUCKET_PREFIX = 'matchmaking:pool';
const DEPTH_KEY = 'matchmaking:depth';
const CLAIMED_PREFIX = 'matchmaking:claimed';

function bucketKey(bucket: number): string {
  return BUCKET_PREFIX + ':' + bucket;
}

function depthKey(bucket: number): string {
  return DEPTH_KEY + ':' + bucket;
}

export async function claimParticipants(
  matchId: string,
  bucket: number,
  ticketIds: string[],
): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  for (const ticketId of ticketIds) {
    const exists = await r.exists(CLAIMED_PREFIX + ':' + ticketId);
    if (exists === 1) return false;
    await r.zrem(bucketKey(bucket), ticketId);
    await r.set(CLAIMED_PREFIX + ':' + ticketId, matchId);
    await r.hincrby(depthKey(bucket), 'waiting', -1);
  }
  return true;
}

export async function cancelTicket(ticketId: string, bucket: number, skill: number): Promise<void> {
  await r.del('matchmaking:open:' + ticketId);
}
`,
      solution: `/** Pool state: one atomic script claims every participant ticket or none. */
import {Redis} from 'ioredis';

export const r = new Redis('redis://redis:6379');

const BUCKET_PREFIX = 'matchmaking:pool';
const DEPTH_KEY = 'matchmaking:depth';
const CLAIMED_PREFIX = 'matchmaking:claimed';

const CLAIM_LUA = \`
local claimed = KEYS[1]
local bucket = KEYS[2]
local depth = KEYS[3]
local count = tonumber(ARGV[1])
for i = 1, count do
  local ticket = ARGV[i + 1]
  if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
    return 0
  end
end
for i = 1, count do
  local ticket = ARGV[i + 1]
  redis.call('ZREM', bucket, ticket)
  redis.call('SET', claimed .. ':' .. ticket, ARGV[count + 2])
end
redis.call('HINCRBY', depth, 0 - count)
return 1
\`;

const CANCEL_LUA = \`
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local ticket = ARGV[1]
local skill = tonumber(ARGV[2])
if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('HINCRBY', depth, 1)
  redis.call('DEL', claimed .. ':' .. ticket)
end
return 1
\`;

function bucketKey(bucket: number): string {
  return BUCKET_PREFIX + ':' + bucket;
}

function depthKey(bucket: number): string {
  return DEPTH_KEY + ':' + bucket;
}

export async function claimParticipants(
  matchId: string,
  bucket: number,
  ticketIds: string[],
): Promise<boolean> {
  const claimed = await r.eval(
    CLAIM_LUA,
    3,
    CLAIMED_PREFIX,
    bucketKey(bucket),
    depthKey(bucket),
    String(ticketIds.length),
    ...ticketIds,
    matchId,
  );
  return claimed === 1;
}

export async function cancelTicket(ticketId: string, bucket: number, skill: number): Promise<void> {
  await r.eval(CANCEL_LUA, 3, bucketKey(bucket), depthKey(bucket), CLAIMED_PREFIX, ticketId, String(skill));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	bucketPrefix  = "matchmaking:pool"
	depthKey      = "matchmaking:depth"
	claimedPrefix = "matchmaking:claimed"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func bucketKey(bucket int) string {
	return bucketPrefix + ":" + strconv.Itoa(bucket)
}

func depthKeyFor(bucket int) string {
	return depthKey + ":" + strconv.Itoa(bucket)
}

func ClaimParticipants(ctx context.Context, matchID string, bucket int, ticketIDs []string) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	for _, id := range ticketIDs {
		exists, err := rdb.Exists(ctx, claimedPrefix+":"+id).Result()
		if err != nil {
			return false, err
		}
		if exists == 1 {
			return false, nil
		}
		rdb.ZRem(ctx, bucketKey(bucket), id)
		rdb.Set(ctx, claimedPrefix+":"+id, matchID, 0)
		rdb.HIncrBy(ctx, depthKeyFor(bucket), "waiting", -1)
	}
	return true, nil
}

func CancelTicket(ctx context.Context, ticketID string, bucket int, skill float64) error {
	rdb.Del(ctx, "matchmaking:open:"+ticketID)
	return nil
}
`,
      solution: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	bucketPrefix  = "matchmaking:pool"
	depthKey      = "matchmaking:depth"
	claimedPrefix = "matchmaking:claimed"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var claimScript = redis.NewScript(\`
local claimed = KEYS[1]
local bucket = KEYS[2]
local depth = KEYS[3]
local count = tonumber(ARGV[1])
for i = 1, count do
  local ticket = ARGV[i + 1]
  if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
    return 0
  end
end
for i = 1, count do
  local ticket = ARGV[i + 1]
  redis.call('ZREM', bucket, ticket)
  redis.call('SET', claimed .. ':' .. ticket, ARGV[count + 2])
end
redis.call('HINCRBY', depth, 0 - count)
return 1
\`)

var cancelScript = redis.NewScript(\`
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local ticket = ARGV[1]
local skill = tonumber(ARGV[2])
if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('HINCRBY', depth, 1)
  redis.call('DEL', claimed .. ':' .. ticket)
end
return 1
\`)

func bucketKey(bucket int) string {
	return bucketPrefix + ":" + strconv.Itoa(bucket)
}

func depthKeyFor(bucket int) string {
	return depthKey + ":" + strconv.Itoa(bucket)
}

func ClaimParticipants(ctx context.Context, matchID string, bucket int, ticketIDs []string) (bool, error) {
	keys := []string{claimedPrefix, bucketKey(bucket), depthKeyFor(bucket)}
	args := make([]any, 0, len(ticketIDs)+2)
	args = append(args, len(ticketIDs))
	for _, id := range ticketIDs {
		args = append(args, id)
	}
	args = append(args, matchID)
	claimed, err := claimScript.Run(ctx, rdb, keys, args...).Int()
	if err != nil {
		return false, err
	}
	return claimed == 1, nil
}

func CancelTicket(ctx context.Context, ticketID string, bucket int, skill float64) error {
	keys := []string{bucketKey(bucket), depthKeyFor(bucket), claimedPrefix}
	return cancelScript.Run(ctx, rdb, keys, ticketID, skill).Err()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object PoolState {
  val BucketPrefix = "matchmaking:pool"
  val DepthKey = "matchmaking:depth"
  val ClaimedPrefix = "matchmaking:claimed"

  val jedis = new Jedis("redis", 6379)

  def bucketKey(bucket: Int): String = BucketPrefix + ":" + bucket
  def depthKeyFor(bucket: Int): String = DepthKey + ":" + bucket

  def claimParticipants(matchId: String, bucket: Int, ticketIds: List[String]): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    ticketIds.forall { id =>
      if (jedis.exists(ClaimedPrefix + ":" + id)) false
      else {
        jedis.zrem(bucketKey(bucket), id)
        jedis.set(ClaimedPrefix + ":" + id, matchId)
        jedis.hincrBy(depthKeyFor(bucket), "waiting", -1)
        true
      }
    }
  }

  def cancelTicket(ticketId: String, bucket: Int, skill: Double): Unit = {
    jedis.del("matchmaking:open:" + ticketId)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object PoolState {
  val BucketPrefix = "matchmaking:pool"
  val DepthKey = "matchmaking:depth"
  val ClaimedPrefix = "matchmaking:claimed"

  val ClaimLua = """
local claimed = KEYS[1]
local bucket = KEYS[2]
local depth = KEYS[3]
local count = tonumber(ARGV[1])
for i = 1, count do
  local ticket = ARGV[i + 1]
  if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
    return 0
  end
end
for i = 1, count do
  local ticket = ARGV[i + 1]
  redis.call('ZREM', bucket, ticket)
  redis.call('SET', claimed .. ':' .. ticket, ARGV[count + 2])
end
redis.call('HINCRBY', depth, 0 - count)
return 1
"""

  val CancelLua = """
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local ticket = ARGV[1]
local skill = tonumber(ARGV[2])
if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('HINCRBY', depth, 1)
  redis.call('DEL', claimed .. ':' .. ticket)
end
return 1
"""

  val jedis = new Jedis("redis", 6379)

  def bucketKey(bucket: Int): String = BucketPrefix + ":" + bucket
  def depthKeyFor(bucket: Int): String = DepthKey + ":" + bucket

  def claimParticipants(matchId: String, bucket: Int, ticketIds: List[String]): Boolean = {
    val keys = List(ClaimedPrefix, bucketKey(bucket), depthKeyFor(bucket)).asJava
    val args = (ticketIds.size.toString :: ticketIds ::: List(matchId)).asJava
    jedis.eval(ClaimLua, keys, args).toString.toLong == 1L
  }

  def cancelTicket(ticketId: String, bucket: Int, skill: Double): Unit = {
    val keys = List(bucketKey(bucket), depthKeyFor(bucket), ClaimedPrefix).asJava
    jedis.eval(CancelLua, keys, List(ticketId, skill.toString).asJava)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using sw::redis::Redis;

const std::string kBucketPrefix = "matchmaking:pool";
const std::string kDepthKey = "matchmaking:depth";
const std::string kClaimedPrefix = "matchmaking:claimed";

Redis r("tcp://redis:6379");

std::string bucketKey(int bucket) { return kBucketPrefix + ":" + std::to_string(bucket); }
std::string depthKeyFor(int bucket) { return kDepthKey + ":" + std::to_string(bucket); }

bool claimParticipants(const std::string& matchId, int bucket, const std::vector<std::string>& ticketIds) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  for (const auto& ticketId : ticketIds) {
    if (r.exists(kClaimedPrefix + ":" + ticketId)) {
      return false;
    }
    r.zrem(bucketKey(bucket), ticketId);
    r.set(kClaimedPrefix + ":" + ticketId, matchId);
    r.hincrby(depthKeyFor(bucket), "waiting", -1);
  }
  return true;
}

void cancelTicket(const std::string& ticketId, int bucket, double skill) {
  r.del("matchmaking:open:" + ticketId);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using sw::redis::Redis;

const std::string kBucketPrefix = "matchmaking:pool";
const std::string kDepthKey = "matchmaking:depth";
const std::string kClaimedPrefix = "matchmaking:claimed";

const std::string CLAIM_LUA = R"LUA(
local claimed = KEYS[1]
local bucket = KEYS[2]
local depth = KEYS[3]
local count = tonumber(ARGV[1])
for i = 1, count do
  local ticket = ARGV[i + 1]
  if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
    return 0
  end
end
for i = 1, count do
  local ticket = ARGV[i + 1]
  redis.call('ZREM', bucket, ticket)
  redis.call('SET', claimed .. ':' .. ticket, ARGV[count + 2])
end
redis.call('HINCRBY', depth, 0 - count)
return 1
)LUA";

const std::string CANCEL_LUA = R"LUA(
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local ticket = ARGV[1]
local skill = tonumber(ARGV[2])
if redis.call('EXISTS', claimed .. ':' .. ticket) == 1 then
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('HINCRBY', depth, 1)
  redis.call('DEL', claimed .. ':' .. ticket)
end
return 1
)LUA";

Redis r("tcp://redis:6379");

std::string bucketKey(int bucket) { return kBucketPrefix + ":" + std::to_string(bucket); }
std::string depthKeyFor(int bucket) { return kDepthKey + ":" + std::to_string(bucket); }

bool claimParticipants(const std::string& matchId, int bucket, const std::vector<std::string>& ticketIds) {
  const std::vector<std::string> keys{kClaimedPrefix, bucketKey(bucket), depthKeyFor(bucket)};
  std::vector<std::string> args{std::to_string(ticketIds.size())};
  args.insert(args.end(), ticketIds.begin(), ticketIds.end());
  args.push_back(matchId);
  const long long claimed = r.eval<long long>(CLAIM_LUA, keys, args);
  return claimed == 1;
}

void cancelTicket(const std::string& ticketId, int bucket, double skill) {
  const std::vector<std::string> keys{bucketKey(bucket), depthKeyFor(bucket), kClaimedPrefix};
  r.eval(CANCEL_LUA, keys, {ticketId, std::to_string(skill)});
}
`,
    },
  },
  hints: [
    'Under two matchmaker instances the same player appears in two match rosters, and the depth counter the scheduler reads stops matching `ZCARD` of the bucket.',
    'Each loop iteration is several round trips; between the `EXISTS` and the `SET` of one ticket the other instance runs the same test and passes. A refused claim also returns mid-loop.',
    'Move the whole decision into one Lua script: test every marker, `return 0` if any is set, then `ZREM`, `SET` and `HINCRBY -N` together. Give `cancel_ticket` a script that `ZADD`s back, `HINCRBY +1` and `DEL`s the marker.',
  ],
  debrief: `The pool is the structure every matchmaker instance reads and writes, so every operation on it is a race until it runs as one Redis command. The claim script tests all markers before it changes anything, which is what makes it all-or-nothing rather than "mostly": a marker set early is exactly what the next instance tests. Moving the depth counter inside the same script keeps it a true cache of the bucket, and the cancel script is the mirror image so a ticket is always in exactly one of waiting, claimed or gone. Production pools add a TTL on the claimed marker so a matchmaker that crashes after claiming cannot pin a roster forever, and a periodic reconciliation that recomputes depth from \`ZCARD\`.`,
};
