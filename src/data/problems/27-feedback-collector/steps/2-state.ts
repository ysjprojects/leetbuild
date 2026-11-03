import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'One ballot per user and request, taken in one Redis command',
  concept: 'redis',
  file: 'state',
  focus: ['collector', 'redis'],
  task: `## Task

**Starting point.** \`state\` exposes \`claim(tenant, request_id, user_id)\`, the ballot the handler
takes before it stores a vote: it builds \`ballot:{request_id}:{user_id}\` with \`ballot_key\`, answers
\`False\` when \`EXISTS\` finds it, otherwise \`SET\`s it and answers \`True\`. It serves the demo and hides
three flaws.

**Failure mode the checks target.** A double-click on the thumbs-up sends two submits that both read
"not taken" and both vote; a user id two tenants share blocks the second tenant's user; and a ballot
has no expiry, so Redis keeps one key per vote for good.

- The ballot key is \`ballot:{tenant}:{request_id}:{user_id}\`.
- The test and the write are one command: \`SET key 1 NX EX BALLOT_TTL_S\` (or a Lua script doing the
  same). \`claim\` answers whether this call took the ballot.
- \`BALLOT_TTL_S\` is 30 days (\`30 * 24 * 3600\`), set by that same command, so no crash can leave a
  ballot without an expiry.`,
  sequence: {
    participants: ['Submit A', 'Submit B', 'Redis'],
    messages: [
      {from: 'Submit A', to: 'Redis', label: 'SET ballot:t-acme:req-1:u-1 1 NX EX 2592000', kind: 'sync'},
      {from: 'Redis', to: 'Submit A', label: 'OK → claimed, store the vote', kind: 'reply'},
      {from: 'Submit B', to: 'Redis', label: 'SET ballot:t-acme:req-1:u-1 1 NX EX 2592000', kind: 'sync'},
      {from: 'Redis', to: 'Submit B', label: 'nil → already voted, store nothing', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'The test and the write are one command',
      detail:
        'The ballot is taken with `SET … NX` (or one Lua script), so of two submits that race, exactly one claims it; the starter runs `EXISTS` and then `SET`, and a submit landing between the two also claims.',
      match: {
        python: {all: [/nx\s*=\s*True|\.eval\(|register_script/], none: [/\.exists\(/, /\.get\(/]},
        typescript: {all: [/['"]NX['"]|\.eval\(|defineCommand/], none: [/\.exists\(/, /\.get\(/]},
        go: {all: [/\.SetNX\(|Mode:\s*"NX"|\.Eval\(|NewScript\(/], none: [/\.Exists\(/, /\.Get\(/]},
        scala: {all: [/\.nx\(\)|\.eval\(/], none: [/\.exists\(/, /\.get\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST|\.eval\b/], none: [/\.exists\(/, /\.get\(/]},
      },
    },
    {
      id: 'tenant-key',
      title: 'The ballot key carries the tenant',
      detail:
        'The key is `ballot:{tenant}:{request_id}:{user_id}`, so two tenants that both have a user `u-1` and a request `req-1` each get a ballot; the starter leaves the tenant out.',
      match: {
        python: {all: [/ballot:\{tenant\}:\{request_id\}:\{user_id\}/]},
        typescript: {all: [/ballot:\$\{tenant\}:\$\{requestId\}:\$\{userId\}/]},
        go: {all: [/"ballot:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*requestID\s*\+\s*":"\s*\+\s*userID/]},
        scala: {all: [/ballot:\$tenant:\$requestId:\$userId/]},
        cpp: {all: [/"ballot:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*request_id\s*\+\s*":"\s*\+\s*user_id/]},
      },
    },
    {
      id: 'expiry',
      title: 'A ballot expires after 30 days, set with the claim',
      detail:
        'The command that takes the ballot sets its 30-day expiry (`BALLOT_TTL_S`); a separate `EXPIRE` leaves a key without one if the process dies in between, and the starter sets none at all.',
      match: {
        python: {
          all: [/BALLOT_TTL_S\s*=\s*(30\s*\*\s*24\s*\*\s*3600|30\s*\*\s*86400|2592000)\b/, /ex\s*=\s*BALLOT_TTL_S/],
          none: [/\.expire\(/],
        },
        typescript: {
          all: [
            /BALLOT_TTL_S\s*=\s*(30\s*\*\s*24\s*\*\s*3600|30\s*\*\s*86400|2592000)\b/,
            /['"]EX['"],\s*BALLOT_TTL_S/,
          ],
          none: [/\.expire\(/],
        },
        go: {
          all: [/ballotTTL\s*=\s*(30\s*\*\s*24\s*\*\s*time\.Hour|720\s*\*\s*time\.Hour)/, /SetNX\([^\n]*ballotTTL\)/],
          none: [/\.Expire\(/],
        },
        scala: {
          all: [/BallotTtlSeconds\s*=\s*(30L?\s*\*\s*24\s*\*\s*3600|2592000)L?\b/, /\.ex\(\s*BallotTtlSeconds\s*\)/],
          none: [/\.expire\(/],
        },
        cpp: {
          all: [/kBallotTtl\{(30\s*\*\s*24\s*\*\s*3600|2592000)\}/, /\.set\([^;]*kBallotTtl/],
          none: [/\.expire\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def ballot_key(request_id: str, user_id: str) -> str:
    return f"ballot:{request_id}:{user_id}"


def claim(tenant: str, request_id: str, user_id: str) -> bool:
    """Take the ballot for (tenant, request_id, user_id): True when this call is the first vote."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    key = ballot_key(request_id, user_id)
    if r.exists(key):
        return False
    r.set(key, "1")
    return True
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BALLOT_TTL_S = 30 * 24 * 3600


def ballot_key(tenant: str, request_id: str, user_id: str) -> str:
    return f"ballot:{tenant}:{request_id}:{user_id}"


def claim(tenant: str, request_id: str, user_id: str) -> bool:
    """Take the ballot for (tenant, request_id, user_id): True when this call is the first vote."""
    # One command: set only if absent, with its expiry. A racing submit gets None.
    return r.set(ballot_key(tenant, request_id, user_id), "1", nx=True, ex=BALLOT_TTL_S) is True
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const ballotKey = (requestId: string, userId: string): string => \`ballot:\${requestId}:\${userId}\`;

/** Take the ballot for (tenant, requestId, userId): true when this call is the first vote. */
export async function claim(tenant: string, requestId: string, userId: string): Promise<boolean> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const key = ballotKey(requestId, userId);
  if ((await redis.exists(key)) === 1) return false;
  await redis.set(key, '1');
  return true;
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const BALLOT_TTL_S = 30 * 24 * 3600;

export const ballotKey = (tenant: string, requestId: string, userId: string): string =>
  \`ballot:\${tenant}:\${requestId}:\${userId}\`;

/** Take the ballot for (tenant, requestId, userId): true when this call is the first vote. */
export async function claim(tenant: string, requestId: string, userId: string): Promise<boolean> {
  // One command: set only if absent, with its expiry. A racing submit gets null.
  return (await redis.set(ballotKey(tenant, requestId, userId), '1', 'EX', BALLOT_TTL_S, 'NX')) === 'OK';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func ballotKey(requestID, userID string) string {
	return "ballot:" + requestID + ":" + userID
}

// claim takes the ballot for (tenant, requestID, userID): true when this call is the first vote.
func claim(ctx context.Context, tenant, requestID, userID string) (bool, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	key := ballotKey(requestID, userID)
	n, err := rdb.Exists(ctx, key).Result()
	if err != nil {
		return false, err
	}
	if n == 1 {
		return false, nil
	}
	if err := rdb.Set(ctx, key, "1", 0).Err(); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

const ballotTTL = 30 * 24 * time.Hour

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func ballotKey(tenant, requestID, userID string) string {
	return "ballot:" + tenant + ":" + requestID + ":" + userID
}

// claim takes the ballot for (tenant, requestID, userID): true when this call is the first vote.
func claim(ctx context.Context, tenant, requestID, userID string) (bool, error) {
	// One command: set only if absent, with its expiry. A racing submit gets false.
	return rdb.SetNX(ctx, ballotKey(tenant, requestID, userID), "1", ballotTTL).Result()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object Ballot {
  private val jedis = new JedisPooled("redis", 6379)

  def ballotKey(requestId: String, userId: String): String = s"ballot:$requestId:$userId"

  /** Take the ballot for (tenant, requestId, userId): true when this call is the first vote. */
  def claim(tenant: String, requestId: String, userId: String): Boolean = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val key = ballotKey(requestId, userId)
    if (jedis.exists(key)) false
    else {
      jedis.set(key, "1")
      true
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object Ballot {
  val BallotTtlSeconds = 30L * 24 * 3600

  private val jedis = new JedisPooled("redis", 6379)

  def ballotKey(tenant: String, requestId: String, userId: String): String = s"ballot:$tenant:$requestId:$userId"

  /** Take the ballot for (tenant, requestId, userId): true when this call is the first vote. */
  def claim(tenant: String, requestId: String, userId: String): Boolean =
    // One command: set only if absent, with its expiry. A racing submit gets null.
    jedis.set(ballotKey(tenant, requestId, userId), "1", SetParams.setParams().nx().ex(BallotTtlSeconds)) == "OK"
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis rdb("tcp://redis:6379");

std::string ballotKey(const std::string& request_id, const std::string& user_id) { return "ballot:" + request_id + ":" + user_id; }

// Take the ballot for (tenant, request_id, user_id): true when this call is the first vote.
bool claim(const std::string& tenant, const std::string& request_id, const std::string& user_id) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string key = ballotKey(request_id, user_id);
  if (rdb.exists(key) == 1) return false;
  rdb.set(key, "1");
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

constexpr std::chrono::seconds kBallotTtl{30 * 24 * 3600};

sw::redis::Redis rdb("tcp://redis:6379");

std::string ballotKey(const std::string& tenant, const std::string& request_id, const std::string& user_id) {
  return "ballot:" + tenant + ":" + request_id + ":" + user_id;
}

// Take the ballot for (tenant, request_id, user_id): true when this call is the first vote.
bool claim(const std::string& tenant, const std::string& request_id, const std::string& user_id) {
  // One command: set only if absent, with its expiry. A racing submit gets false.
  return rdb.set(ballotKey(tenant, request_id, user_id), "1", kBallotTtl, sw::redis::UpdateType::NOT_EXIST);
}
`,
    },
  },
  harness: {
    python: `TTL = 30 * 24 * 3600
KEY = "ballot:t-acme:req-1:u-1"
# The starter's layout, so the race is staged whichever key the code uses.
LOOSE_KEY = "ballot:req-1:u-1"


def _double_click(ctx, m):
    """A second submit of the same vote lands right after this submit's first Redis command."""
    probes = [ctx.redis_after(key, lambda: m.claim("t-acme", "req-1", "u-1")) for key in (KEY, LOOSE_KEY)]
    first = m.claim("t-acme", "req-1", "u-1")
    fired = [p for p in probes if p.fired]
    assert fired, f"claim touched neither {KEY} nor {LOOSE_KEY}; Redis holds {sorted(ctx.redis.keys('*'))}"
    if fired[0].error is not None:
        raise fired[0].error
    return first, fired[0].result


def check_atomic_claim(ctx):
    m = ctx.load("state")
    first, second = _double_click(ctx, m)
    claimed = [first, second].count(True)
    assert claimed == 1, f"a double-click claimed the ballot {claimed} times (the two submits answered {first} and {second}): the test and the write must be one command"
    assert m.claim("t-acme", "req-1", "u-1") is False, "a third submit of the same vote must find the ballot taken"


def check_tenant_key(ctx):
    m = ctx.load("state")
    assert m.claim("t-acme", "req-1", "u-1") is True, "the first vote of u-1 on req-1 in t-acme must take the ballot"
    assert m.claim("t-other", "req-1", "u-1") is True, "tenant t-other has its own req-1 and its own u-1, and its vote was refused: the ballot key leaves the tenant out"
    assert m.claim("t-acme", "req-1", "u-2") is True, "another user of the same request has a ballot of their own"
    assert m.claim("t-acme", "req-1", "u-1") is False, "u-1 voting again on req-1 in t-acme must be refused"
    keys = sorted(ctx.redis.keys("ballot:*"))
    want = ["ballot:t-acme:req-1:u-1", "ballot:t-acme:req-1:u-2", "ballot:t-other:req-1:u-1"]
    assert keys == want, f"the ballots are {keys}, expected {want} (ballot:{{tenant}}:{{request_id}}:{{user_id}})"


def check_expiry(ctx):
    m = ctx.load("state")
    at_write = ctx.redis_after(KEY, lambda: ctx.redis.ttl(KEY))
    assert m.claim("t-acme", "req-1", "u-1") is True, "the first vote must take the ballot"
    keys = ctx.redis.keys("ballot:*")
    assert keys, "claim stored no ballot key"
    ttl = ctx.redis.ttl(keys[0])
    assert TTL - 5 <= ttl <= TTL, f"the ballot {keys[0]} has TTL {ttl}, expected 30 days ({TTL} s): a ballot without an expiry is kept forever"
    if at_write.fired:
        assert at_write.result != -1, f"right after the command that wrote {KEY} it had no expiry: a crash before the EXPIRE leaves it forever. Set it in the same command (SET ... NX EX)"
    ctx.clock.advance(TTL + 1)
    assert ctx.redis.keys("ballot:*") == [], f"30 days later the ballot is still there: {ctx.redis.keys('ballot:*')}"
`,
    typescript: `const TTL = 30 * 24 * 3600;
const KEY = 'ballot:t-acme:req-1:u-1';
// The starter's layout, so the race is staged whichever key the code uses.
const LOOSE_KEY = 'ballot:req-1:u-1';

/** A second submit of the same vote lands right after this submit's first Redis command. */
async function doubleClick(ctx, m): Promise<[boolean, boolean]> {
  const probes = [KEY, LOOSE_KEY].map(key => ctx.redisAfter(key, () => m.claim('t-acme', 'req-1', 'u-1')));
  const first = await m.claim('t-acme', 'req-1', 'u-1');
  const fired = probes.filter(p => p.fired);
  assert(fired.length > 0, \`claim touched neither \${KEY} nor \${LOOSE_KEY}; Redis holds \${JSON.stringify(ctx.redis.keys('*'))}\`);
  if (fired[0].error !== undefined) throw fired[0].error;
  return [first, await fired[0].result];
}

export async function check_atomic_claim(ctx) {
  const m = ctx.load('state');
  const [first, second] = await doubleClick(ctx, m);
  const claimed = [first, second].filter(x => x === true).length;
  assert.equal(claimed, 1, \`a double-click claimed the ballot \${claimed} times (the two submits answered \${first} and \${second}): the test and the write must be one command\`);
  assert.equal(await m.claim('t-acme', 'req-1', 'u-1'), false, 'a third submit of the same vote must find the ballot taken');
}

export async function check_tenant_key(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.claim('t-acme', 'req-1', 'u-1'), true, 'the first vote of u-1 on req-1 in t-acme must take the ballot');
  assert.equal(await m.claim('t-other', 'req-1', 'u-1'), true, 'tenant t-other has its own req-1 and its own u-1, and its vote was refused: the ballot key leaves the tenant out');
  assert.equal(await m.claim('t-acme', 'req-1', 'u-2'), true, 'another user of the same request has a ballot of their own');
  assert.equal(await m.claim('t-acme', 'req-1', 'u-1'), false, 'u-1 voting again on req-1 in t-acme must be refused');
  const keys = ctx.redis.keys('ballot:*').sort();
  const want = ['ballot:t-acme:req-1:u-1', 'ballot:t-acme:req-1:u-2', 'ballot:t-other:req-1:u-1'];
  assert.deepEqual(keys, want, \`the ballots are \${JSON.stringify(keys)}, expected \${JSON.stringify(want)} (ballot:{tenant}:{request_id}:{user_id})\`);
}

export async function check_expiry(ctx) {
  const m = ctx.load('state');
  const atWrite = ctx.redisAfter(KEY, () => ctx.redis.ttl(KEY));
  assert.equal(await m.claim('t-acme', 'req-1', 'u-1'), true, 'the first vote must take the ballot');
  const keys = ctx.redis.keys('ballot:*');
  assert(keys.length > 0, 'claim stored no ballot key');
  const ttl = ctx.redis.ttl(keys[0]);
  assert(TTL - 5 <= ttl && ttl <= TTL, \`the ballot \${keys[0]} has TTL \${ttl}, expected 30 days (\${TTL} s): a ballot without an expiry is kept forever\`);
  if (atWrite.fired) {
    assert.notEqual(atWrite.result, -1, \`right after the command that wrote \${KEY} it had no expiry: a crash before the EXPIRE leaves it forever. Set it in the same command (SET ... NX EX)\`);
  }
  ctx.clock.advance(TTL + 1);
  assert.deepEqual(ctx.redis.keys('ballot:*'), [], \`30 days later the ballot is still there: \${JSON.stringify(ctx.redis.keys('ballot:*'))}\`);
}
`,
    go: `package main

import (
	"context"
	"sort"

	"leetbuild/harness"
)

var stateBg = context.Background()

const (
	ballotTTLSeconds = 30 * 24 * 3600
	exactKey         = "ballot:t-acme:req-1:u-1"
	// The starter's layout, so the race is staged whichever key the code uses.
	looseKey = "ballot:req-1:u-1"
)

func mustClaim(ctx *harness.Ctx, tenant, requestID, userID string) bool {
	ok, err := claim(stateBg, tenant, requestID, userID)
	ctx.NoError(err, "claim(%s, %s, %s)", tenant, requestID, userID)
	return ok
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	rival := func() any {
		ok, err := claim(stateBg, "t-acme", "req-1", "u-1")
		if err != nil {
			return err
		}
		return ok
	}
	// A second submit of the same vote lands right after this submit's first Redis command.
	exact := ctx.Redis.After(exactKey, rival)
	loose := ctx.Redis.After(looseKey, rival)
	first := mustClaim(ctx, "t-acme", "req-1", "u-1")
	ctx.Assert(exact.Fired || loose.Fired, "claim touched neither %s nor %s; Redis holds %q", exactKey, looseKey, ctx.Redis.Keys("*"))
	second := exact.Result
	if loose.Fired {
		second = loose.Result
	}
	claimed := 0
	for _, v := range []any{first, second} {
		if v == true {
			claimed++
		}
	}
	ctx.Equal(claimed, 1, "a double-click must claim the ballot once (the two submits answered %v and %v): the test and the write must be one command; claims", first, second)
	ctx.Equal(mustClaim(ctx, "t-acme", "req-1", "u-1"), false, "a third submit of the same vote must find the ballot taken")
}

func CheckTenantKey(ctx *harness.Ctx) {
	ctx.Equal(mustClaim(ctx, "t-acme", "req-1", "u-1"), true, "the first vote of u-1 on req-1 in t-acme must take the ballot")
	ctx.Equal(mustClaim(ctx, "t-other", "req-1", "u-1"), true, "tenant t-other has its own req-1 and its own u-1, and its vote was refused: the ballot key leaves the tenant out")
	ctx.Equal(mustClaim(ctx, "t-acme", "req-1", "u-2"), true, "another user of the same request has a ballot of their own")
	ctx.Equal(mustClaim(ctx, "t-acme", "req-1", "u-1"), false, "u-1 voting again on req-1 in t-acme must be refused")
	keys := ctx.Redis.Keys("ballot:*")
	sort.Strings(keys)
	ctx.Equal(keys, []string{"ballot:t-acme:req-1:u-1", "ballot:t-acme:req-1:u-2", "ballot:t-other:req-1:u-1"}, "the ballots (ballot:{tenant}:{request_id}:{user_id})")
}

func CheckExpiry(ctx *harness.Ctx) {
	atWrite := ctx.Redis.After(exactKey, func() any { return ctx.Redis.TTL(exactKey) })
	ctx.Equal(mustClaim(ctx, "t-acme", "req-1", "u-1"), true, "the first vote must take the ballot")
	keys := ctx.Redis.Keys("ballot:*")
	ctx.Assert(len(keys) > 0, "claim stored no ballot key")
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(ballotTTLSeconds-5 <= ttl && ttl <= ballotTTLSeconds, "the ballot %s has TTL %d, expected 30 days (%d s): a ballot without an expiry is kept forever", keys[0], ttl, ballotTTLSeconds)
	if atWrite.Fired {
		ctx.Assert(atWrite.Result != int64(-1), "right after the command that wrote %s it had no expiry: a crash before the EXPIRE leaves it forever. Set it in the same command (SET ... NX EX)", exactKey)
	}
	ctx.Clock.Advance(ballotTTLSeconds + 1)
	ctx.Equal(len(ctx.Redis.Keys("ballot:*")), 0, "30 days later the ballot must be gone; ballots")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

namespace {

constexpr long long kTtl = 30LL * 24 * 3600;
const std::string kKey = "ballot:t-acme:req-1:u-1";
// The starter's layout, so the race is staged whichever key the code uses.
const std::string kLooseKey = "ballot:req-1:u-1";

struct Rival {
  bool fired = false;
  bool claimed = false;
  long long ttl = 0;
  std::string err;
};

std::shared_ptr<Rival> rivalClaim(harness::Ctx& ctx, const std::string& key) {
  auto out = std::make_shared<Rival>();
  ctx.Redis.After(key, [out] {
    out->fired = true;
    try {
      out->claimed = claim("t-acme", "req-1", "u-1");
    } catch (const std::exception& e) {
      out->err = e.what();
    }
  });
  return out;
}

}  // namespace

void CheckAtomicClaim(harness::Ctx& ctx) {
  // A second submit of the same vote lands right after this submit's first Redis command.
  const auto exact = rivalClaim(ctx, kKey);
  const auto loose = rivalClaim(ctx, kLooseKey);
  const bool first = claim("t-acme", "req-1", "u-1");
  ctx.Assert(exact->fired || loose->fired, "claim touched neither %s nor %s; Redis holds %q", kKey, kLooseKey, ctx.Redis.Keys("*"));
  const Rival& rival = exact->fired ? *exact : *loose;
  ctx.Assert(rival.err.empty(), "the second submit failed: %s", rival.err);
  const int claimed = (first ? 1 : 0) + (rival.claimed ? 1 : 0);
  ctx.Equal(claimed, 1, "a double-click must claim the ballot once (the two submits answered %t and %t): the test and the write must be one command; claims", first, rival.claimed);
  ctx.Equal(claim("t-acme", "req-1", "u-1"), false, "a third submit of the same vote must find the ballot taken");
}

void CheckTenantKey(harness::Ctx& ctx) {
  ctx.Equal(claim("t-acme", "req-1", "u-1"), true, "the first vote of u-1 on req-1 in t-acme must take the ballot");
  ctx.Equal(claim("t-other", "req-1", "u-1"), true, "tenant t-other has its own req-1 and its own u-1, and its vote was refused: the ballot key leaves the tenant out");
  ctx.Equal(claim("t-acme", "req-1", "u-2"), true, "another user of the same request has a ballot of their own");
  ctx.Equal(claim("t-acme", "req-1", "u-1"), false, "u-1 voting again on req-1 in t-acme must be refused");
  std::vector<std::string> keys = ctx.Redis.Keys("ballot:*");
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, {"ballot:t-acme:req-1:u-1", "ballot:t-acme:req-1:u-2", "ballot:t-other:req-1:u-1"}, "the ballots (ballot:{tenant}:{request_id}:{user_id})");
}

void CheckExpiry(harness::Ctx& ctx) {
  auto at_write = std::make_shared<Rival>();
  ctx.Redis.After(kKey, [at_write, &ctx] {
    at_write->fired = true;
    at_write->ttl = ctx.Redis.TTL(kKey);
  });
  ctx.Equal(claim("t-acme", "req-1", "u-1"), true, "the first vote must take the ballot");
  const auto keys = ctx.Redis.Keys("ballot:*");
  ctx.Assert(!keys.empty(), "claim stored no ballot key");
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(kTtl - 5 <= ttl && ttl <= kTtl, "the ballot %s has TTL %d, expected 30 days (%d s): a ballot without an expiry is kept forever", keys[0], ttl, kTtl);
  if (at_write->fired) {
    ctx.Assert(at_write->ttl != -1, "right after the command that wrote %s it had no expiry: a crash before the EXPIRE leaves it forever. Set it in the same command (SET ... NX EX)", kKey);
  }
  ctx.Clock.Advance(kTtl + 1);
  ctx.Equal(ctx.Redis.Keys("ballot:*").size(), 0, "30 days later the ballot must be gone; ballots");
}
`,
  },
  hints: [
    'Double-click the thumbs-up: the dashboard counts two votes. Then have two tenants that both have a user `u-1` rate their own `req-1`: the second is told it already voted.',
    '`EXISTS` and `SET` are two round trips, and a second submit fits between them; the key is built from the request and the user only; and the `SET` carries no expiry.',
    'Build `ballot:{tenant}:{request_id}:{user_id}` and take it with one `SET key 1 NX EX BALLOT_TTL_S` (`nx=True, ex=BALLOT_TTL_S`), answering whether it was set; drop the `EXISTS`.',
  ],
  debrief: `\`SET NX EX\` makes Redis the arbiter: two submits can arrive in any order and exactly one sees the key set, which a read followed by a write cannot promise. The tenant goes in the key because user ids and request ids are only unique inside a tenant. Setting the expiry in the same command matters because a separate \`EXPIRE\` is a second round trip a crash can skip, leaving a key that never goes away. Production ballots usually let a user change their vote (a Lua script that swaps the old rating for the new one in the tallies), and size the expiry to how long a request accepts feedback.`,
};
