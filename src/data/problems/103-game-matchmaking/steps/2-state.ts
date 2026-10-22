import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis pool buckets with atomic claims',
  concept: 'redis',
  file: 'state',
  focus: ['matchmaker', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it takes a candidate roster
from the pool and claims the tickets in a loop. It compiles, it passes the single-threaded demo, and
it hides the flaw that produces the worst bug in matchmaking. Review it, fix it, and prove the fix.

Implement the pool module the matchmaker uses when it forms a match:

- \`claim_participants(match_id, bucket, ticket_ids)\` claims **every** participant ticket in **one
  atomic Lua \`EVAL\`**: first test whether any ticket is already claimed, then, only if the whole
  roster is free, remove every ticket from the bucket and mark it claimed with the match id. If any
  ticket is already claimed the script returns **0** without touching the pool and the caller gets
  \`false\`. The draft tests and claims one ticket at a time, so two matchmakers racing over an
  overlapping pool both pass the "already claimed" test and put one player in two rosters.
- A claimed ticket must be **invisible to other matchmakers**: the script \`ZREM\`s the ticket from its
  bucket in the same step that marks it claimed. A ticket left in the bucket is still handed out by
  the next pool scan.
- The **depth counter** \`{DEPTH_KEY}:{bucket}\` must match the set of waiting tickets after both a
  claim and a cancellation: the claim script \`HINCRBY\`s the depth down by the number of tickets it
  removes, and \`cancel_ticket\` \`HINCRBY\`s it back up when a ticket returns to the pool. The draft's
  client-side loop leaves the counter behind as soon as a claim is partially refused.
- \`cancel_ticket(ticket_id, bucket, skill)\` must **return the ticket to its bucket**: \`ZADD\` it back
  at its skill, restore the depth counter, and clear the claimed marker. The draft deletes the
  open-ticket pointer only, so the ticket ends up neither in the pool nor in a match — a ghost.
- Nothing may mark a ticket claimed before the whole roster is known to be free: the marker is what
  the next matchmaker's script tests.

**Failure mode the checks target.** The race is the headline: two matchmakers, one pool, one player
claimed twice. The second flaw is quieter — the depth counter drifts the moment a cancellation or a
partially-refused claim happens, so the pool size the scheduler reads stops matching the tickets that
are actually waiting. The third is the ghost ticket: a cancellation that leaves the ticket out of the
pool and out of the claimed set, so neither a match nor a cancel can ever clear it.`,
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
        'Every participant ticket is claimed by one `EVAL`/`NewScript` run. The draft checks and claims one ticket at a time, so a concurrent matchmaker can claim an overlapping ticket between two of its commands.',
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
        'The script tests the claimed markers first and returns **0** without touching the pool when any ticket is already claimed, so a half-claimed roster is impossible. The draft returns after removing some tickets, leaving those tickets claimed by a match that will never form.',
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
        'The script `ZREM`s each ticket from its bucket as it marks it claimed, so another matchmaker scanning the bucket can never see a ticket that is already in a match. The draft leaves claimed tickets in the bucket.',
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
        'The same script moves the depth counter `HINCRBY depth -N` when it removes tickets, and the cancel path moves it back, so `{DEPTH_KEY}:{bucket}` always equals the tickets still waiting. The draft updates the counter outside the claim, so a refused or cancelled ticket leaves it wrong.',
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
        '`cancel_ticket` `ZADD`s the ticket back into its bucket at its skill, restores the depth counter and clears the claimed marker — so the ticket can be matched again. The draft deletes the open-ticket pointer only and leaves a ghost.',
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
    # TODO: this draft claims the tickets one at a time, so two matchmakers racing over an
    # overlapping pool can both pass the "already claimed" test and put one player in two rosters.
    # Claim every participant in one atomic script, keep claimed tickets out of the bucket, keep the
    # depth counter honest, and put the ticket back in its bucket on cancel.
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
      starter: `/** Pool state: a model-generated draft that claims tickets one at a time. */
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
  // TODO: this draft claims the tickets one at a time, so two matchmakers racing over an
  // overlapping pool can both pass the "already claimed" test and put one player in two rosters.
  // Claim every participant in one atomic script, keep claimed tickets out of the bucket, keep the
  // depth counter honest, and put the ticket back in its bucket on cancel.
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
	// TODO: this draft claims the tickets one at a time, so two matchmakers racing over an
	// overlapping pool can both pass the "already claimed" test and put one player in two rosters.
	// Claim every participant in one atomic script, keep claimed tickets out of the bucket, keep the
	// depth counter honest, and put the ticket back in its bucket on cancel.
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
    // TODO: this draft claims the tickets one at a time, so two matchmakers racing over an
    // overlapping pool can both pass the "already claimed" test and put one player in two rosters.
    // Claim every participant in one atomic script, keep claimed tickets out of the bucket, keep the
    // depth counter honest, and put the ticket back in its bucket on cancel.
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
  // TODO: this draft claims the tickets one at a time, so two matchmakers racing over an overlapping
  // pool can both pass the "already claimed" test and put one player in two rosters. Claim every
  // participant in one atomic script, keep claimed tickets out of the bucket, keep the depth counter
  // honest, and put the ticket back in its bucket on cancel.
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
    'Everything that decides the claim has to run inside one script: the "is this ticket already claimed" test for **every** participant, the `ZREM` of every ticket, the `SET` of every marker and the depth decrement. A client-side loop has a window between each pair of commands, and that window is exactly where the second matchmaker gets in.',
    'The marker is what the next matchmaker tests, so never set one before the whole roster is known to be free: test all participants first, `return 0` on the first claimed one, and only then remove and mark. That is what makes the claim all-or-nothing instead of "mostly".',
    'The depth counter is a cache of "how many tickets are waiting here", so every path that moves a ticket has to move it too: down by `N` in the claim script, up by one in `cancel_ticket`. If cancel only deletes the open-ticket pointer, the ticket is neither waiting nor claimed — a ghost that will never be matched and never be released.',
  ],
  debrief: `The interviewer is testing whether you know what the pool is *for*: it is the shared structure every matchmaker instance reads and writes, so every operation on it is a race until proven otherwise. The draft fails on three levels. First, the claim is not atomic — checking and claiming ticket by ticket means two matchmakers can both see the same free ticket, and the loser's roster still gets formed with a player who is already in a game. Second, a partially-refused claim leaves markers set on tickets that were removed from the pool and will never be released, so those players wait in a queue position that no longer exists. Third, the depth counter is moved outside the atomic unit, so the number the scheduler reads drifts away from the tickets that are actually waiting. The right shape is one Lua script that tests every marker, refuses as a whole, and then removes and marks as a whole — and a cancel path that is the exact inverse: put the ticket back, restore the depth, clear the marker. Real pools add ticket TTLs so a crashed process cannot strand a ticket, per-bucket depth keys so a hot bucket does not contend with a cold one, and a "candidate" phase where the matchmaker claims with a short lease before it commits the roster — which is what the next step builds on when the allocation fails.`,
};
