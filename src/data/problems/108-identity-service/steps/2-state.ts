import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis handle claims: one owner per address and number',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the claim store the signup path calls:
\`claim_handles(user_id, handles)\` takes every handle of a signup (\`{"email": …, "phone": …}\`,
canonical) as \`handle:{kind}:{value}\` → user id, checking each key with \`EXISTS\` and writing it
with \`SET … EX CLAIM_TTL_S\` (7 days); a taken handle makes it call
\`release_handles(user_id, handles)\`, which deletes the keys, and answer \`False\`. \`owner_of\` reads
a claim. Sequential signups get one account per address; it hides three flaws.

**Failure mode the checks target.** Two signups for one address in the same instant both get it; a
signup refused because the phone is taken deletes the claim of the account that owns the phone; and
a week after signing up, a stranger can claim a live account's address.

- One \`SET … NX\` per handle both tests and claims it; its reply decides.
- \`release_handles\` deletes a key only while it still holds \`user_id\`: one compare-and-delete Lua
  script per key (\`GET\`, compare with \`ARGV[1]\`, \`DEL\`).
- A claim lasts as long as the account: no expiry.`,
  sequence: {
    participants: ['Signup A', 'Signup B', 'Redis'],
    messages: [
      {from: 'Signup A', to: 'Redis', label: 'SET handle:email:ada@example.com u-1 NX', kind: 'sync'},
      {from: 'Redis', to: 'Signup A', label: 'OK: u-1 owns the address', kind: 'reply'},
      {from: 'Signup B', to: 'Redis', label: 'SET handle:email:ada@example.com u-2 NX', kind: 'sync'},
      {from: 'Redis', to: 'Signup B', label: 'nil: taken', kind: 'reply'},
      {from: 'Signup B', to: 'Redis', label: 'EVAL release: DEL only if the key holds u-2', kind: 'sync'},
      {from: 'Redis', to: 'Signup B', label: '0: u-1 keeps its claim', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'claim',
      title: 'Claims and releases handles as handle:{kind}:{value}',
      detail:
        '`claim_handles` writes `handle:{kind}:{value}` holding the user id for every handle, `owner_of` reads it, and `release_handles` gives a user its own handles back.',
      match: {
        python: {all: [/def claim_handles\(/, /def release_handles\(/, /def handle_key\(/]},
        typescript: {all: [/function claimHandles\(/, /function releaseHandles\(/, /handleKey/]},
        go: {all: [/func claimHandles\(/, /func releaseHandles\(/, /func handleKey\(/]},
        scala: {all: [/def claimHandles\(/, /def releaseHandles\(/, /def handleKey\(/]},
        cpp: {all: [/bool claimHandles\(/, /void releaseHandles\(/, /std::string handleKey\(/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'One SET NX tests and claims a handle',
      detail:
        'Each handle is claimed with one set-if-absent (`nx=True`, `NX`, `SetNX`, `.nx()`, `UpdateType::NOT_EXIST`) whose reply decides; the starter checks with `EXISTS` and writes with a separate `SET`, so a second signup landing between the two commands also wins.',
      match: {
        python: {all: [/\.set\([^\n]*nx=True/], none: [/\.exists\(/]},
        typescript: {all: [/\.set\([^\n]*'NX'/], none: [/\.exists\(/]},
        go: {all: [/\.SetNX\(/], none: [/\.Exists\(/]},
        scala: {all: [/\.nx\(\)/], none: [/jedis\.exists\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/], none: [/\.exists\(/]},
      },
    },
    {
      id: 'owner-release',
      title: 'Releases only the handles the user still owns',
      detail:
        '`release_handles` deletes a key only while it holds the releasing user id, in one compare-and-delete Lua script; the starter deletes every key it is given, including the claim of the account that made the signup lose.',
      match: {
        python: {all: [/redis\.call\(\s*['"]GET['"]|\.watch\(/, /ARGV\[1\]/], none: [/\.delete\(/]},
        typescript: {all: [/redis\.call\(\s*['"]GET['"]|\.watch\(/, /ARGV\[1\]/], none: [/\.del\(/]},
        go: {all: [/redis\.call\(\s*'GET'|\.Watch\(/, /ARGV\[1\]/], none: [/rdb\.Del\(/]},
        scala: {all: [/redis\.call\(\s*'GET'|\.watch\(/, /ARGV\[1\]/], none: [/jedis\.del\(/]},
        cpp: {all: [/redis\.call\(\s*'GET'|\.watch\(/, /ARGV\[1\]/], none: [/redis\(\)\.del\(/]},
      },
    },
    {
      id: 'durable-claim',
      title: 'A claim lasts as long as the account',
      detail:
        'Claims carry no expiry, so a live account keeps its handles; the starter writes them with a 7-day `EX`, after which a second account can claim the same address.',
      match: {
        python: {all: [/nx=True/], none: [/\bex\s*=/, /\.expire\(/, /CLAIM_TTL_S\s*=/]},
        typescript: {all: [/'NX'/], none: [/'EX'/, /\.expire\(/, /CLAIM_TTL_S\s*=/]},
        go: {all: [/\.SetNX\(/], none: [/claimTTL\s*=/, /\.Expire\(/]},
        scala: {all: [/\.nx\(\)/], none: [/\.ex\(/, /\.expire\(/, /ClaimTtlSeconds\s*[:=]/]},
        cpp: {all: [/UpdateType::NOT_EXIST/], none: [/kClaimTtl\{/, /\.expire\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

HANDLE_PREFIX = "handle"
CLAIM_TTL_S = 7 * 24 * 3600  # a claim from a signup nobody finished frees itself


def handle_key(kind: str, value: str) -> str:
    return f"{HANDLE_PREFIX}:{kind}:{value}"


def owner_of(kind: str, value: str) -> str | None:
    """The user id that owns the handle, or None."""
    return r.get(handle_key(kind, value))


def release_handles(user_id: str, handles: dict[str, str]) -> None:
    """Give back the handles (kind → value) of user_id's signup."""
    r.delete(*[handle_key(kind, value) for kind, value in handles.items()])


def claim_handles(user_id: str, handles: dict[str, str]) -> bool:
    """Claim every handle (kind → value) for user_id; False, holding none of them, when one is taken."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    for kind, value in handles.items():
        key = handle_key(kind, value)
        if r.exists(key):
            release_handles(user_id, handles)  # give back what this signup took
            return False
        r.set(key, user_id, ex=CLAIM_TTL_S)
    return True
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

HANDLE_PREFIX = "handle"

# Deletes the claim only while it still names the releasing user.
RELEASE_LUA = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
"""
release = r.register_script(RELEASE_LUA)


def handle_key(kind: str, value: str) -> str:
    return f"{HANDLE_PREFIX}:{kind}:{value}"


def owner_of(kind: str, value: str) -> str | None:
    """The user id that owns the handle, or None."""
    return r.get(handle_key(kind, value))


def release_handles(user_id: str, handles: dict[str, str]) -> None:
    """Give back the handles (kind → value) that user_id still owns."""
    for kind, value in handles.items():
        release(keys=[handle_key(kind, value)], args=[user_id])


def claim_handles(user_id: str, handles: dict[str, str]) -> bool:
    """Claim every handle (kind → value) for user_id; False, holding none of them, when one is taken."""
    for kind, value in handles.items():
        # One command tests and claims; no expiry: the claim lives as long as the account.
        if not r.set(handle_key(kind, value), user_id, nx=True):
            release_handles(user_id, handles)  # give back what this signup took
            return False
    return True
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const HANDLE_PREFIX = 'handle';
export const CLAIM_TTL_S = 7 * 24 * 3600; // a claim from a signup nobody finished frees itself

export const handleKey = (kind: string, value: string): string => \`\${HANDLE_PREFIX}:\${kind}:\${value}\`;

/** The user id that owns the handle, or null. */
export async function ownerOf(kind: string, value: string): Promise<string | null> {
  return redis.get(handleKey(kind, value));
}

/** Give back the handles (kind → value) of userId's signup. */
export async function releaseHandles(userId: string, handles: Record<string, string>): Promise<void> {
  await redis.del(...Object.entries(handles).map(([kind, value]) => handleKey(kind, value)));
}

/** Claim every handle (kind → value) for userId; false, holding none of them, when one is taken. */
export async function claimHandles(userId: string, handles: Record<string, string>): Promise<boolean> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  for (const [kind, value] of Object.entries(handles)) {
    const key = handleKey(kind, value);
    if ((await redis.exists(key)) === 1) {
      await releaseHandles(userId, handles); // give back what this signup took
      return false;
    }
    await redis.set(key, userId, 'EX', CLAIM_TTL_S);
  }
  return true;
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const HANDLE_PREFIX = 'handle';

/** Deletes the claim only while it still names the releasing user. */
export const RELEASE_LUA = \`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
\`;

export const handleKey = (kind: string, value: string): string => \`\${HANDLE_PREFIX}:\${kind}:\${value}\`;

/** The user id that owns the handle, or null. */
export async function ownerOf(kind: string, value: string): Promise<string | null> {
  return redis.get(handleKey(kind, value));
}

/** Give back the handles (kind → value) that userId still owns. */
export async function releaseHandles(userId: string, handles: Record<string, string>): Promise<void> {
  for (const [kind, value] of Object.entries(handles)) await redis.eval(RELEASE_LUA, 1, handleKey(kind, value), userId);
}

/** Claim every handle (kind → value) for userId; false, holding none of them, when one is taken. */
export async function claimHandles(userId: string, handles: Record<string, string>): Promise<boolean> {
  for (const [kind, value] of Object.entries(handles)) {
    // One command tests and claims; no expiry: the claim lives as long as the account.
    if ((await redis.set(handleKey(kind, value), userId, 'NX')) === null) {
      await releaseHandles(userId, handles); // give back what this signup took
      return false;
    }
  }
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const handlePrefix = "handle"

const claimTTL = 7 * 24 * time.Hour // a claim from a signup nobody finished frees itself

func handleKey(kind, value string) string { return handlePrefix + ":" + kind + ":" + value }

// ownerOf is the user id that owns the handle, or "".
func ownerOf(ctx context.Context, kind, value string) string {
	return rdb.Get(ctx, handleKey(kind, value)).Val()
}

// releaseHandles gives back the handles (kind → value) of userID's signup.
func releaseHandles(ctx context.Context, userID string, handles map[string]string) error {
	keys := make([]string, 0, len(handles))
	for kind, value := range handles {
		keys = append(keys, handleKey(kind, value))
	}
	return rdb.Del(ctx, keys...).Err()
}

// claimHandles claims every handle (kind → value) for userID; false, holding none of them, when one is taken.
func claimHandles(ctx context.Context, userID string, handles map[string]string) (bool, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	for kind, value := range handles {
		key := handleKey(kind, value)
		taken, err := rdb.Exists(ctx, key).Result()
		if err != nil {
			return false, err
		}
		if taken > 0 {
			return false, releaseHandles(ctx, userID, handles) // give back what this signup took
		}
		if err := rdb.Set(ctx, key, userID, claimTTL).Err(); err != nil {
			return false, err
		}
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const handlePrefix = "handle"

// releaseScript deletes the claim only while it still names the releasing user.
var releaseScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
\`)

func handleKey(kind, value string) string { return handlePrefix + ":" + kind + ":" + value }

// ownerOf is the user id that owns the handle, or "".
func ownerOf(ctx context.Context, kind, value string) string {
	return rdb.Get(ctx, handleKey(kind, value)).Val()
}

// releaseHandles gives back the handles (kind → value) that userID still owns.
func releaseHandles(ctx context.Context, userID string, handles map[string]string) error {
	for kind, value := range handles {
		if err := releaseScript.Run(ctx, rdb, []string{handleKey(kind, value)}, userID).Err(); err != nil {
			return err
		}
	}
	return nil
}

// claimHandles claims every handle (kind → value) for userID; false, holding none of them, when one is taken.
func claimHandles(ctx context.Context, userID string, handles map[string]string) (bool, error) {
	for kind, value := range handles {
		// One command tests and claims; no expiry: the claim lives as long as the account.
		won, err := rdb.SetNX(ctx, handleKey(kind, value), userID, 0).Result()
		if err != nil {
			return false, err
		}
		if !won {
			return false, releaseHandles(ctx, userID, handles) // give back what this signup took
		}
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object Claims {
  val HandlePrefix = "handle"
  val ClaimTtlSeconds: Long = 7 * 24 * 3600L // a claim from a signup nobody finished frees itself

  private val jedis = new JedisPooled("redis", 6379)

  def handleKey(kind: String, value: String): String = s"$HandlePrefix:$kind:$value"

  /** The user id that owns the handle, if any. */
  def ownerOf(kind: String, value: String): Option[String] = Option(jedis.get(handleKey(kind, value)))

  /** Give back the handles (kind → value) of userId's signup. */
  def releaseHandles(userId: String, handles: Map[String, String]): Unit =
    jedis.del(handles.map { case (kind, value) => handleKey(kind, value) }.toSeq: _*)

  /** Claim every handle (kind → value) for userId; false, holding none of them, when one is taken. */
  def claimHandles(userId: String, handles: Map[String, String]): Boolean = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val lost = handles.exists { case (kind, value) =>
      val key = handleKey(kind, value)
      if (jedis.exists(key)) true
      else {
        jedis.set(key, userId, SetParams.setParams().ex(ClaimTtlSeconds))
        false
      }
    }
    if (lost) releaseHandles(userId, handles) // give back what this signup took
    !lost
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

object Claims {
  val HandlePrefix = "handle"

  /** Deletes the claim only while it still names the releasing user. */
  val ReleaseLua: String =
    """if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      |return redis.call('DEL', KEYS[1])
      |""".stripMargin

  private val jedis = new JedisPooled("redis", 6379)

  def handleKey(kind: String, value: String): String = s"$HandlePrefix:$kind:$value"

  /** The user id that owns the handle, if any. */
  def ownerOf(kind: String, value: String): Option[String] = Option(jedis.get(handleKey(kind, value)))

  /** Give back the handles (kind → value) that userId still owns. */
  def releaseHandles(userId: String, handles: Map[String, String]): Unit =
    handles.foreach { case (kind, value) => jedis.eval(ReleaseLua, List(handleKey(kind, value)).asJava, List(userId).asJava) }

  /** Claim every handle (kind → value) for userId; false, holding none of them, when one is taken. */
  def claimHandles(userId: String, handles: Map[String, String]): Boolean = {
    // One command tests and claims; no expiry: the claim lives as long as the account.
    val lost = handles.exists { case (kind, value) => jedis.set(handleKey(kind, value), userId, SetParams.setParams().nx()) == null }
    if (lost) releaseHandles(userId, handles) // give back what this signup took
    !lost
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <vector>

using Handles = std::map<std::string, std::string>;  // kind → canonical value

const std::string kHandlePrefix = "handle";
const std::chrono::seconds kClaimTtl{7 * 24 * 3600};  // a claim from a signup nobody finished frees itself

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string handleKey(const std::string& kind, const std::string& value) { return kHandlePrefix + ":" + kind + ":" + value; }

// The user id that owns the handle, or none.
std::optional<std::string> ownerOf(const std::string& kind, const std::string& value) {
  const auto owner = redis().get(handleKey(kind, value));
  if (!owner) return std::nullopt;
  return *owner;
}

// Give back the handles of user_id's signup.
void releaseHandles(const std::string& user_id, const Handles& handles) {
  std::vector<std::string> keys;
  for (const auto& [kind, value] : handles) keys.push_back(handleKey(kind, value));
  redis().del(keys.begin(), keys.end());
}

// Claim every handle for user_id; false, holding none of them, when one is taken.
bool claimHandles(const std::string& user_id, const Handles& handles) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  for (const auto& [kind, value] : handles) {
    const std::string key = handleKey(kind, value);
    if (redis().exists(key)) {
      releaseHandles(user_id, handles);  // give back what this signup took
      return false;
    }
    redis().set(key, user_id, kClaimTtl);
  }
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>

using Handles = std::map<std::string, std::string>;  // kind → canonical value

const std::string kHandlePrefix = "handle";

// Deletes the claim only while it still names the releasing user.
const std::string kReleaseLua = R"lua(
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
)lua";

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string handleKey(const std::string& kind, const std::string& value) { return kHandlePrefix + ":" + kind + ":" + value; }

// The user id that owns the handle, or none.
std::optional<std::string> ownerOf(const std::string& kind, const std::string& value) {
  const auto owner = redis().get(handleKey(kind, value));
  if (!owner) return std::nullopt;
  return *owner;
}

// Give back the handles that user_id still owns.
void releaseHandles(const std::string& user_id, const Handles& handles) {
  for (const auto& [kind, value] : handles) redis().eval<long long>(kReleaseLua, {handleKey(kind, value)}, {user_id});
}

// Claim every handle for user_id; false, holding none of them, when one is taken.
bool claimHandles(const std::string& user_id, const Handles& handles) {
  for (const auto& [kind, value] : handles) {
    // One command tests and claims; no expiry: the claim lives as long as the account.
    if (!redis().set(handleKey(kind, value), user_id, std::chrono::milliseconds(0), sw::redis::UpdateType::NOT_EXIST)) {
      releaseHandles(user_id, handles);  // give back what this signup took
      return false;
    }
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `ADA = {"email": "ada@example.com", "phone": "+442079460958"}
EMAIL_KEY = "handle:email:ada@example.com"
PHONE_KEY = "handle:phone:+442079460958"


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_claim(ctx):
    m = ctx.load("state")
    assert m.claim_handles("u-1", ADA) is True, "claiming two free handles must succeed"
    assert ctx.redis.get(EMAIL_KEY) == "u-1", f"{EMAIL_KEY} holds {ctx.redis.get(EMAIL_KEY)!r}, expected u-1"
    assert ctx.redis.get(PHONE_KEY) == "u-1", f"{PHONE_KEY} holds {ctx.redis.get(PHONE_KEY)!r}, expected u-1"
    assert m.owner_of("email", "ada@example.com") == "u-1", f"owner_of gives {m.owner_of('email', 'ada@example.com')!r}, expected u-1"
    m.release_handles("u-1", ADA)
    assert ctx.redis.keys("handle:*") == [], f"after u-1 released its own handles Redis still holds {ctx.redis.keys('handle:*')}"


def check_atomic_claim(ctx):
    m = ctx.load("state")
    # A second signup for the same address runs right after this one's first command on the key.
    rival = ctx.redis_after(EMAIL_KEY, lambda: m.claim_handles("u-2", {"email": "ada@example.com"}))
    won = m.claim_handles("u-1", {"email": "ada@example.com"})
    rival_won = _settled(rival, EMAIL_KEY)
    assert not (won and rival_won), f"two signups for ada@example.com in the same instant both claimed it (u-1: {won}, u-2: {rival_won}): a check and a separate write let both through. Claim with one SET NX"
    assert won or rival_won, "neither of two signups for ada@example.com claimed it"
    winner = "u-1" if won else "u-2"
    assert ctx.redis.get(EMAIL_KEY) == winner, f"{EMAIL_KEY} holds {ctx.redis.get(EMAIL_KEY)!r}, but the claim that succeeded was {winner}'s"


def check_owner_release(ctx):
    m = ctx.load("state")
    assert m.claim_handles("u-1", ADA) is True, "claiming two free handles must succeed"
    # A second signup with a new address and u-1's phone loses on the phone.
    lost = m.claim_handles("u-2", {"email": "eve@example.com", "phone": "+442079460958"})
    assert lost is False, "a signup with a phone u-1 holds must be refused"
    assert ctx.redis.get(PHONE_KEY) == "u-1", f"after u-2's refused signup {PHONE_KEY} holds {ctx.redis.get(PHONE_KEY)!r}: the refused signup deleted u-1's claim. Release only the handles you own"
    assert ctx.redis.get("handle:email:eve@example.com") is None, "the refused signup kept its claim on eve@example.com"
    m.release_handles("u-2", ADA)
    assert ctx.redis.get(EMAIL_KEY) == "u-1" and ctx.redis.get(PHONE_KEY) == "u-1", "release_handles('u-2', …) deleted claims that belong to u-1"
    assert m.claim_handles("u-3", {"email": "zoe@example.com", "phone": "+442079460958"}) is False, "a third signup claimed the phone u-1 owns"


def check_durable_claim(ctx):
    m = ctx.load("state")
    assert m.claim_handles("u-1", ADA) is True, "claiming two free handles must succeed"
    for key in (EMAIL_KEY, PHONE_KEY):
        ttl = ctx.redis.ttl(key)
        assert ttl == -1, f"{key} expires in {ttl} s: once it lapses a second account can take a live account's handle. A claim lasts as long as the account"
    ctx.clock.advance(8 * 24 * 3600)
    assert m.claim_handles("u-2", {"email": "ada@example.com"}) is False, "eight days later a second signup claimed ada@example.com, which u-1 still owns"
`,
    typescript: `const ADA = {email: 'ada@example.com', phone: '+442079460958'};
const EMAIL_KEY = 'handle:email:ada@example.com';
const PHONE_KEY = 'handle:phone:+442079460958';

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_claim(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.claimHandles('u-1', ADA), true, 'claiming two free handles must succeed');
  assert.equal(ctx.redis.get(EMAIL_KEY), 'u-1', \`\${EMAIL_KEY} holds \${JSON.stringify(ctx.redis.get(EMAIL_KEY))}, expected u-1\`);
  assert.equal(ctx.redis.get(PHONE_KEY), 'u-1', \`\${PHONE_KEY} holds \${JSON.stringify(ctx.redis.get(PHONE_KEY))}, expected u-1\`);
  assert.equal(await m.ownerOf('email', 'ada@example.com'), 'u-1', 'ownerOf must give the owner u-1');
  await m.releaseHandles('u-1', ADA);
  assert.deepStrictEqual(ctx.redis.keys('handle:*'), [], \`after u-1 released its own handles Redis still holds \${JSON.stringify(ctx.redis.keys('handle:*'))}\`);
}

export async function check_atomic_claim(ctx) {
  const m = ctx.load('state');
  // A second signup for the same address runs right after this one's first command on the key.
  const rival = ctx.redisAfter(EMAIL_KEY, () => m.claimHandles('u-2', {email: 'ada@example.com'}));
  const won = await m.claimHandles('u-1', {email: 'ada@example.com'});
  const rivalWon = await settled(rival, EMAIL_KEY);
  assert(!(won && rivalWon), \`two signups for ada@example.com in the same instant both claimed it (u-1: \${won}, u-2: \${rivalWon}): a check and a separate write let both through. Claim with one SET NX\`);
  assert(won || rivalWon, 'neither of two signups for ada@example.com claimed it');
  const winner = won ? 'u-1' : 'u-2';
  assert.equal(ctx.redis.get(EMAIL_KEY), winner, \`\${EMAIL_KEY} holds \${JSON.stringify(ctx.redis.get(EMAIL_KEY))}, but the claim that succeeded was \${winner}'s\`);
}

export async function check_owner_release(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.claimHandles('u-1', ADA), true, 'claiming two free handles must succeed');
  // A second signup with a new address and u-1's phone loses on the phone.
  assert.equal(await m.claimHandles('u-2', {email: 'eve@example.com', phone: '+442079460958'}), false, "a signup with a phone u-1 holds must be refused");
  assert.equal(ctx.redis.get(PHONE_KEY), 'u-1', \`after u-2's refused signup \${PHONE_KEY} holds \${JSON.stringify(ctx.redis.get(PHONE_KEY))}: the refused signup deleted u-1's claim. Release only the handles you own\`);
  assert.equal(ctx.redis.get('handle:email:eve@example.com'), null, 'the refused signup kept its claim on eve@example.com');
  await m.releaseHandles('u-2', ADA);
  assert(ctx.redis.get(EMAIL_KEY) === 'u-1' && ctx.redis.get(PHONE_KEY) === 'u-1', "releaseHandles('u-2', …) deleted claims that belong to u-1");
  assert.equal(await m.claimHandles('u-3', {email: 'zoe@example.com', phone: '+442079460958'}), false, 'a third signup claimed the phone u-1 owns');
}

export async function check_durable_claim(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.claimHandles('u-1', ADA), true, 'claiming two free handles must succeed');
  for (const key of [EMAIL_KEY, PHONE_KEY]) {
    const ttl = ctx.redis.ttl(key);
    assert.equal(ttl, -1, \`\${key} expires in \${ttl} s: once it lapses a second account can take a live account's handle. A claim lasts as long as the account\`);
  }
  ctx.clock.advance(8 * 24 * 3600);
  assert.equal(await m.claimHandles('u-2', {email: 'ada@example.com'}), false, 'eight days later a second signup claimed ada@example.com, which u-1 still owns');
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"
)

var (
	stateBg  = context.Background()
	adaClaim = map[string]string{"email": "ada@example.com", "phone": "+442079460958"}
)

const (
	emailKey = "handle:email:ada@example.com"
	phoneKey = "handle:phone:+442079460958"
)

func mustClaim(ctx *harness.Ctx, userID string, handles map[string]string) bool {
	won, err := claimHandles(stateBg, userID, handles)
	ctx.NoError(err, "claimHandles(%s, %v) failed", userID, handles)
	return won
}

func holder(ctx *harness.Ctx, key string) string {
	v, _ := ctx.Redis.Get(key)
	return v
}

func CheckClaim(ctx *harness.Ctx) {
	ctx.Equal(mustClaim(ctx, "u-1", adaClaim), true, "claiming two free handles must succeed; won")
	ctx.Equal(holder(ctx, emailKey), "u-1", "%s must hold the owner", emailKey)
	ctx.Equal(holder(ctx, phoneKey), "u-1", "%s must hold the owner", phoneKey)
	ctx.Equal(ownerOf(stateBg, "email", "ada@example.com"), "u-1", "ownerOf(email, ada@example.com)")
	ctx.NoError(releaseHandles(stateBg, "u-1", adaClaim), "releaseHandles(u-1) failed")
	ctx.Equal(len(ctx.Redis.Keys("handle:*")), 0, "after u-1 released its own handles Redis still holds %v; the claims", ctx.Redis.Keys("handle:*"))
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	// A second signup for the same address runs right after this one's first command on the key.
	rival := ctx.Redis.After(emailKey, func() any {
		won, err := claimHandles(stateBg, "u-2", map[string]string{"email": "ada@example.com"})
		ctx.NoError(err, "the rival claim failed")
		return won
	})
	won := mustClaim(ctx, "u-1", map[string]string{"email": "ada@example.com"})
	ctx.Assert(rival.Fired, "nothing touched %s", emailKey)
	ctx.Assert(rival.Err == nil, "the rival claim failed: %v", rival.Err)
	rivalWon := rival.Result == true
	ctx.Assert(!(won && rivalWon), "two signups for ada@example.com in the same instant both claimed it (u-1: %v, u-2: %v): a check and a separate write let both through. Claim with one SET NX", won, rivalWon)
	ctx.Assert(won || rivalWon, "neither of two signups for ada@example.com claimed it")
	winner := "u-2"
	if won {
		winner = "u-1"
	}
	ctx.Equal(holder(ctx, emailKey), winner, "%s must hold the signup whose claim succeeded", emailKey)
}

func CheckOwnerRelease(ctx *harness.Ctx) {
	ctx.Equal(mustClaim(ctx, "u-1", adaClaim), true, "claiming two free handles must succeed; won")
	// A second signup with a new address and u-1's phone loses on the phone.
	ctx.Equal(mustClaim(ctx, "u-2", map[string]string{"email": "eve@example.com", "phone": "+442079460958"}), false, "a signup with a phone u-1 holds must be refused; won")
	ctx.Equal(holder(ctx, phoneKey), "u-1", "after u-2's refused signup the refused signup deleted u-1's claim (release only the handles you own); %s holds", phoneKey)
	ctx.Equal(holder(ctx, "handle:email:eve@example.com"), "", "the refused signup must not keep its claim on eve@example.com; it holds")
	ctx.NoError(releaseHandles(stateBg, "u-2", adaClaim), "releaseHandles(u-2) failed")
	ctx.Assert(holder(ctx, emailKey) == "u-1" && holder(ctx, phoneKey) == "u-1", "releaseHandles(u-2, …) deleted claims that belong to u-1")
	ctx.Equal(mustClaim(ctx, "u-3", map[string]string{"email": "zoe@example.com", "phone": "+442079460958"}), false, "a third signup must not claim the phone u-1 owns; won")
}

func CheckDurableClaim(ctx *harness.Ctx) {
	ctx.Equal(mustClaim(ctx, "u-1", adaClaim), true, "claiming two free handles must succeed; won")
	for _, key := range []string{emailKey, phoneKey} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl == -1, "%s expires in %d s: once it lapses a second account can take a live account's handle. A claim lasts as long as the account", key, ttl)
	}
	ctx.Clock.Advance(8 * 24 * 3600)
	ctx.Equal(mustClaim(ctx, "u-2", map[string]string{"email": "ada@example.com"}), false, "eight days later a second signup must not claim ada@example.com, which u-1 still owns; won")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

namespace {

const Handles kAda = {{"email", "ada@example.com"}, {"phone", "+442079460958"}};
const std::string kEmailKey = "handle:email:ada@example.com";
const std::string kPhoneKey = "handle:phone:+442079460958";

std::string holder(harness::Ctx& ctx, const std::string& key) { return ctx.Redis.Get(key).value_or(""); }

}  // namespace

void CheckClaim(harness::Ctx& ctx) {
  ctx.Equal(claimHandles("u-1", kAda), true, "claiming two free handles must succeed; won");
  ctx.Equal(holder(ctx, kEmailKey), "u-1", "%s must hold the owner", kEmailKey);
  ctx.Equal(holder(ctx, kPhoneKey), "u-1", "%s must hold the owner", kPhoneKey);
  ctx.Equal(ownerOf("email", "ada@example.com").value_or(""), "u-1", "ownerOf(email, ada@example.com)");
  releaseHandles("u-1", kAda);
  ctx.Assert(ctx.Redis.Keys("handle:*").empty(), "after u-1 released its own handles Redis still holds %v", ctx.Redis.Keys("handle:*"));
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  // A second signup for the same address runs right after this one's first command on the key.
  struct Rival {
    bool fired = false;
    bool won = false;
    std::optional<std::string> err;
  };
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After(kEmailKey, [rival] {
    rival->fired = true;
    try {
      rival->won = claimHandles("u-2", {{"email", "ada@example.com"}});
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const bool won = claimHandles("u-1", {{"email", "ada@example.com"}});
  ctx.Assert(rival->fired, "nothing touched %s", kEmailKey);
  ctx.Assert(!rival->err, "the rival claim failed: %s", rival->err.value_or(""));
  ctx.Assert(!(won && rival->won), "two signups for ada@example.com in the same instant both claimed it (u-1: %t, u-2: %t): a check and a separate write let both through. Claim with one SET NX", won, rival->won);
  ctx.Assert(won || rival->won, "neither of two signups for ada@example.com claimed it");
  ctx.Equal(holder(ctx, kEmailKey), won ? "u-1" : "u-2", "%s must hold the signup whose claim succeeded", kEmailKey);
}

void CheckOwnerRelease(harness::Ctx& ctx) {
  ctx.Equal(claimHandles("u-1", kAda), true, "claiming two free handles must succeed; won");
  // A second signup with a new address and u-1's phone loses on the phone.
  ctx.Equal(claimHandles("u-2", {{"email", "eve@example.com"}, {"phone", "+442079460958"}}), false, "a signup with a phone u-1 holds must be refused; won");
  ctx.Equal(holder(ctx, kPhoneKey), "u-1", "after u-2's refused signup the refused signup deleted u-1's claim (release only the handles you own); %s holds", kPhoneKey);
  ctx.Equal(holder(ctx, "handle:email:eve@example.com"), "", "the refused signup must not keep its claim on eve@example.com; it holds");
  releaseHandles("u-2", kAda);
  ctx.Assert(holder(ctx, kEmailKey) == "u-1" && holder(ctx, kPhoneKey) == "u-1", "releaseHandles(u-2, …) deleted claims that belong to u-1");
  ctx.Equal(claimHandles("u-3", {{"email", "zoe@example.com"}, {"phone", "+442079460958"}}), false, "a third signup must not claim the phone u-1 owns; won");
}

void CheckDurableClaim(harness::Ctx& ctx) {
  ctx.Equal(claimHandles("u-1", kAda), true, "claiming two free handles must succeed; won");
  for (const std::string& key : {kEmailKey, kPhoneKey}) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl == -1, "%s expires in %d s: once it lapses a second account can take a live account's handle. A claim lasts as long as the account", key, ttl);
  }
  ctx.Clock.Advance(8 * 24 * 3600);
  ctx.Equal(claimHandles("u-2", {{"email", "ada@example.com"}}), false, "eight days later a second signup must not claim ada@example.com, which u-1 still owns; won");
}
`,
  },
  hints: [
    'Fire two signups for one address at once: both get it. Sign up with a taken phone: the next signup gets that phone too. Wait a week: the address is free again.',
    '`EXISTS` and `SET` are two round trips, and another signup can land between them. `release_handles` deletes every key it is given, including the one another account owns. `EX` makes every claim temporary.',
    'Claim with `SET key user_id NX` and no `EX`, and let its reply decide. Release each key with one Lua script: `GET` the key, return 0 unless it equals `ARGV[1]`, else `DEL` it.',
  ],
  debrief: `A claim is a write that answers a question, so the question and the write have to be one command: \`SET NX\` is the whole uniqueness index, and the signup that gets \`nil\` lost cleanly. Releasing needs the same care from the other side: the key names its owner, and only the owner may delete it, which is a compare-and-delete in one script because a \`GET\` then \`DEL\` reopens the window. A claim outlives any TTL a signup could choose, because the account it protects does. What the course leaves to a sweeper is the orphan: a signup that claimed and crashed before writing its row; production services sweep claims whose account never appeared, and keep the uniqueness index in the accounts database as a second line.`,
};
