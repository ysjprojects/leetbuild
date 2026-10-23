import type {Step} from '@/lib/types';

export const leaseLockStep: Step = {
  id: 'lease-lock',
  title: 'A lock with a lease, released safely',
  concept: 'redis',
  file: 'lease_lock',
  focus: ['worker', 'redis'],
  task: `## Task

Implement the module \`lease_lock\`: one key \`lock:{name}\` per lock, holding the **owner** that took
it, alive for a **lease** in milliseconds. The owner is an opaque string the caller chooses (a uuid
per attempt); a worker that crashes never releases, so the lease is what frees the lock.

- \`acquire(name, owner, ttl_ms) -> bool\`: one command, \`SET lock:{name} owner NX PX ttl_ms\`. \`True\`
  only when the \`SET\` happened; \`False\` while anyone — this owner included, the lock is not
  reentrant — holds it. A refused acquire changes nothing.
- \`release(name, owner) -> bool\`: delete the key **only if its value is still \`owner\`**, as **one Lua
  script** (\`GET\` and \`DEL\` inside \`EVAL\`). \`True\` when the lock was held by this owner and is now
  free; \`False\` otherwise, touching nothing. A plain \`DEL\` is wrong: it frees whoever holds the lock
  now.
- \`extend(name, owner, ttl_ms) -> bool\`: the same compare, then \`PEXPIRE\` to \`ttl_ms\` from now,
  in one script. \`False\` for a non-owner, for a lease that already ran out and for a lock nobody
  holds — none of those creates or changes the key.
- Everything the caller needs is in the return value; the functions do not raise on a refused call.

:::widget idempotency {}

> The owner is a fencing token for the lock itself: every write to \`lock:{name}\` after the first
> one is a compare-and-write on that value, and the compare runs on the server.`,
  sequence: {
    participants: ['worker A', 'worker B', 'Redis'],
    messages: [
      {from: 'worker A', to: 'Redis', label: 'SET lock:job a-7f3 NX PX 30000', kind: 'sync'},
      {from: 'Redis', to: 'worker A', label: 'OK → True', kind: 'reply'},
      {from: 'worker B', to: 'Redis', label: 'SET lock:job b-c12 NX PX 30000', kind: 'sync'},
      {from: 'Redis', to: 'worker B', label: 'nil → False', kind: 'reply'},
      {from: 'worker A', to: 'Redis', label: 'EVAL extend lock:job a-7f3 30000', kind: 'sync'},
      {from: 'Redis', to: 'worker A', label: '1 (PEXPIRE ran)', kind: 'reply'},
      {from: 'worker B', to: 'Redis', label: 'EVAL release lock:job b-c12', kind: 'sync'},
      {from: 'Redis', to: 'worker B', label: '0 — value is a-7f3, nothing deleted', kind: 'reply'},
      {from: 'worker A', to: 'Redis', label: 'EVAL release lock:job a-7f3', kind: 'sync'},
      {from: 'Redis', to: 'worker A', label: '1 — deleted', kind: 'reply'},
    ],
  },
  hints: [
    '`acquire` is a single `SET` with both `NX` and `PX`; the reply (`OK` or nil) is the return value. Never `SETNX` then `PEXPIRE`: a crash between the two leaves a lock with no lease.',
    "Both scripts start the same way: `if redis.call('GET', KEYS[1]) == ARGV[1] then … end return 0`. Release returns `redis.call('DEL', KEYS[1])`; extend returns `redis.call('PEXPIRE', KEYS[1], ARGV[2])`. Pass the key as `KEYS[1]` and the owner (and ttl) as `ARGV`.",
    'The harness lands another owner between a client-side `GET` and `DEL`; only a script, which Redis runs without interleaving, passes the race check. Compare the reply to `1` for the boolean.',
  ],
  checks: [
    {
      id: 'mutual-exclusion',
      title: 'One owner at a time',
      detail:
        '`acquire` is `SET lock:{name} owner NX PX ttl_ms`: the first caller gets `True` and the key holds its owner; a second owner (or the same one again) gets `False` while the lock is held, and the key is untouched.',
      match: {
        python: {all: [/f"lock:\{name\}"/, /\.set\(.*\bnx=True\b/]},
        typescript: {all: [/`lock:\$\{name\}`/, /\.set\(.*'NX'/]},
        go: {all: [/"lock:"\s*\+\s*name/, /rdb\.SetNX\(/]},
        scala: {all: [/s"lock:\$name"/, /\.nx\(\)/]},
        cpp: {all: [/"lock:"\s*\+\s*name/, /UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'lease-ttl',
      title: 'The lease is a PX TTL and frees the lock by itself',
      detail:
        'The key carries a TTL of `ttl_ms` milliseconds (`PX`, not `EX`); while it runs other owners are refused, and once it has elapsed another owner acquires without anyone releasing.',
      match: {
        python: {all: [/px=ttl_ms/], none: [/\bex=/]},
        typescript: {all: [/'PX'\s*,\s*ttlMs/], none: [/'EX'/]},
        go: {all: [/time\.Duration\(ttlMs\)\s*\*\s*time\.Millisecond/]},
        scala: {all: [/\.px\(ttlMs\)/], none: [/\.ex\(/]},
        cpp: {all: [/std::chrono::milliseconds\(ttl_ms\)/], none: [/std::chrono::seconds\(/]},
      },
    },
    {
      id: 'release-owner-only',
      title: 'Only the owner can release',
      detail:
        '`release` deletes the key only when its value is this owner: a non-owner (and an owner whose lease ran out and was taken over) gets `False` and the lock keeps its holder and lease; the owner gets `True` and the key is gone; a plain `DEL` is never sent.',
      match: {
        python: {
          all: [
            /redis\.call\(\s*'GET'\s*,\s*KEYS\[1\]\s*\)\s*==\s*ARGV\[1\]/,
            /redis\.call\(\s*'DEL'\s*,\s*KEYS\[1\]\s*\)/,
          ],
          none: [/\br\.delete\(/, /\br\.unlink\(/],
        },
        typescript: {
          all: [
            /redis\.call\(\s*'GET'\s*,\s*KEYS\[1\]\s*\)\s*==\s*ARGV\[1\]/,
            /redis\.call\(\s*'DEL'\s*,\s*KEYS\[1\]\s*\)/,
          ],
          none: [/redis\.del\(/, /redis\.unlink\(/],
        },
        go: {
          all: [
            /redis\.call\(\s*'GET'\s*,\s*KEYS\[1\]\s*\)\s*==\s*ARGV\[1\]/,
            /redis\.call\(\s*'DEL'\s*,\s*KEYS\[1\]\s*\)/,
          ],
          none: [/rdb\.Del\(/, /rdb\.Unlink\(/],
        },
        scala: {
          all: [
            /redis\.call\(\s*'GET'\s*,\s*KEYS\[1\]\s*\)\s*==\s*ARGV\[1\]/,
            /redis\.call\(\s*'DEL'\s*,\s*KEYS\[1\]\s*\)/,
          ],
          none: [/jedis\.del\(/, /jedis\.unlink\(/],
        },
        cpp: {
          all: [
            /redis\.call\(\s*'GET'\s*,\s*KEYS\[1\]\s*\)\s*==\s*ARGV\[1\]/,
            /redis\.call\(\s*'DEL'\s*,\s*KEYS\[1\]\s*\)/,
          ],
          none: [/redis\.del\(/, /redis\.unlink\(/],
        },
      },
    },
    {
      id: 'extend-owner-only',
      title: 'Only the owner can extend, and only a live lease',
      detail:
        '`extend` by the owner sets the lease to `ttl_ms` from now (`PEXPIRE` inside the script) and returns `True`; by a non-owner it returns `False` and the TTL does not move; on a lock nobody holds (or whose lease has already run out) it returns `False` and creates nothing.',
      match: {
        python: {
          all: [/redis\.call\(\s*'PEXPIRE'\s*,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/],
          none: [/\br\.pexpire\(/, /\br\.expire\(/],
        },
        typescript: {
          all: [/redis\.call\(\s*'PEXPIRE'\s*,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/],
          none: [/redis\.pexpire\(/, /redis\.expire\(/],
        },
        go: {
          all: [/redis\.call\(\s*'PEXPIRE'\s*,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/],
          none: [/rdb\.PExpire\(/, /rdb\.Expire\(/],
        },
        scala: {
          all: [/redis\.call\(\s*'PEXPIRE'\s*,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/],
          none: [/jedis\.pexpire\(/, /jedis\.expire\(/],
        },
        cpp: {
          all: [/redis\.call\(\s*'PEXPIRE'\s*,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/],
          none: [/redis\.pexpire\(/, /redis\.expire\(/],
        },
      },
    },
    {
      id: 'release-atomic',
      title: 'Release is one script: compare and delete cannot interleave',
      detail:
        'The owner’s lease runs out and another owner takes the lock right after the release has read the key; a client-side `GET` then `DEL` deletes the new owner’s lock, a script sees the old value and deletes, or the new one and does nothing. The new owner must still hold the lock afterwards.',
      match: {
        python: {
          all: [/register_script\(|\br\.eval\(/],
          order: [/==\s*ARGV\[1\]/, /redis\.call\(\s*'DEL'/],
          none: [/\br\.get\(/, /\.pipeline\(/, /\.multi\(/],
        },
        typescript: {
          all: [/redis\.eval\(|defineCommand\(/],
          order: [/==\s*ARGV\[1\]/, /redis\.call\(\s*'DEL'/],
          none: [/redis\.get\(/, /\.pipeline\(/, /\.multi\(/],
        },
        go: {
          all: [/redis\.NewScript\(|rdb\.Eval\(/],
          order: [/==\s*ARGV\[1\]/, /redis\.call\(\s*'DEL'/],
          none: [/rdb\.Get\(/, /\.TxPipeline\(/, /\.Pipeline\(/],
        },
        scala: {
          all: [/scriptLoad\(|jedis\.eval\(/],
          order: [/==\s*ARGV\[1\]/, /redis\.call\(\s*'DEL'/],
          none: [/jedis\.get\(/, /\.pipelined\(/, /\.multi\(/],
        },
        cpp: {
          all: [/script_load\(|redis\.eval</],
          order: [/==\s*ARGV\[1\]/, /redis\.call\(\s*'DEL'/],
          none: [/redis\.get\(/, /\.pipeline\(/, /\.transaction\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] = lock:{name}   ARGV[1] = owner
# Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
RELEASE_LUA = """
return 0
"""  # TODO: GET KEYS[1] == ARGV[1] → return DEL KEYS[1]; the compare and the delete in one script

# KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttl_ms
# Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
EXTEND_LUA = """
return 0
"""  # TODO: GET KEYS[1] == ARGV[1] → return PEXPIRE KEYS[1] ARGV[2]

release_script = r.register_script(RELEASE_LUA)
extend_script = r.register_script(EXTEND_LUA)


def lock_key(name: str) -> str:
    return f"lock:{name}"


def acquire(name: str, owner: str, ttl_ms: int) -> bool:
    """True when this owner now holds lock:{name} for ttl_ms; False while anyone holds it."""
    # TODO: one SET with NX and PX; True only when the SET happened
    raise NotImplementedError


def release(name: str, owner: str) -> bool:
    """True when the lock was held by this owner and is now free; False otherwise, touching nothing."""
    # TODO: release_script(keys=[lock_key(name)], args=[owner]) == 1
    raise NotImplementedError


def extend(name: str, owner: str, ttl_ms: int) -> bool:
    """True when the lock was held by this owner and now lives ttl_ms from now; False otherwise."""
    # TODO: extend_script(keys=[lock_key(name)], args=[owner, ttl_ms]) == 1
    raise NotImplementedError
`,
      solution: `"""A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] = lock:{name}   ARGV[1] = owner
# Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""

# KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttl_ms
# Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
EXTEND_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
"""

release_script = r.register_script(RELEASE_LUA)
extend_script = r.register_script(EXTEND_LUA)


def lock_key(name: str) -> str:
    return f"lock:{name}"


def acquire(name: str, owner: str, ttl_ms: int) -> bool:
    """True when this owner now holds lock:{name} for ttl_ms; False while anyone holds it."""
    return r.set(lock_key(name), owner, nx=True, px=ttl_ms) is True


def release(name: str, owner: str) -> bool:
    """True when the lock was held by this owner and is now free; False otherwise, touching nothing."""
    return release_script(keys=[lock_key(name)], args=[owner]) == 1


def extend(name: str, owner: str, ttl_ms: int) -> bool:
    """True when the lock was held by this owner and now lives ttl_ms from now; False otherwise."""
    return extend_script(keys=[lock_key(name)], args=[owner, ttl_ms]) == 1
`,
    },
    typescript: {
      starter: `/** A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

// KEYS[1] = lock:{name}   ARGV[1] = owner
// Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
// TODO: GET KEYS[1] == ARGV[1] → return DEL KEYS[1]; the compare and the delete in one script
const RELEASE_LUA = \`
return 0
\`;

// KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttlMs
// Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
// TODO: GET KEYS[1] == ARGV[1] → return PEXPIRE KEYS[1] ARGV[2]
const EXTEND_LUA = \`
return 0
\`;

export const lockKey = (name: string): string => \`lock:\${name}\`;

/** True when this owner now holds lock:{name} for ttlMs; false while anyone holds it. */
export async function acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
  // TODO: one SET with NX and PX; true only when the reply is OK
  throw new Error('not implemented');
}

/** True when the lock was held by this owner and is now free; false otherwise, touching nothing. */
export async function release(name: string, owner: string): Promise<boolean> {
  // TODO: redis.eval(RELEASE_LUA, 1, lockKey(name), owner) === 1
  throw new Error('not implemented');
}

/** True when the lock was held by this owner and now lives ttlMs from now; false otherwise. */
export async function extend(name: string, owner: string, ttlMs: number): Promise<boolean> {
  // TODO: redis.eval(EXTEND_LUA, 1, lockKey(name), owner, ttlMs) === 1
  throw new Error('not implemented');
}
`,
      solution: `/** A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

// KEYS[1] = lock:{name}   ARGV[1] = owner
// Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
const RELEASE_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
\`;

// KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttlMs
// Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
const EXTEND_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
\`;

export const lockKey = (name: string): string => \`lock:\${name}\`;

/** True when this owner now holds lock:{name} for ttlMs; false while anyone holds it. */
export async function acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
  return (await redis.set(lockKey(name), owner, 'PX', ttlMs, 'NX')) === 'OK';
}

/** True when the lock was held by this owner and is now free; false otherwise, touching nothing. */
export async function release(name: string, owner: string): Promise<boolean> {
  return (await redis.eval(RELEASE_LUA, 1, lockKey(name), owner)) === 1;
}

/** True when the lock was held by this owner and now lives ttlMs from now; false otherwise. */
export async function extend(name: string, owner: string, ttlMs: number): Promise<boolean> {
  return (await redis.eval(EXTEND_LUA, 1, lockKey(name), owner, ttlMs)) === 1;
}
`,
    },
    go: {
      starter: `// A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it.
package main

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS[1] = lock:{name}   ARGV[1] = owner
// Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
// TODO: GET KEYS[1] == ARGV[1] → return DEL KEYS[1]; the compare and the delete in one script
const releaseLua = \`
return 0
\`

// KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttl_ms
// Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
// TODO: GET KEYS[1] == ARGV[1] → return PEXPIRE KEYS[1] ARGV[2]
const extendLua = \`
return 0
\`

var (
	releaseScript = redis.NewScript(releaseLua)
	extendScript  = redis.NewScript(extendLua)
)

func lockKey(name string) string { return "lock:" + name }

// acquire is true when this owner now holds lock:{name} for ttlMs; false while anyone holds it.
func acquire(ctx context.Context, name, owner string, ttlMs int64) (bool, error) {
	// TODO: one SET with NX and time.Duration(ttlMs)*time.Millisecond (import "time"); go-redis sends PX for sub-second precision, EX for whole seconds
	return false, errors.New("not implemented")
}

// release is true when the lock was held by this owner and is now free; false otherwise, touching nothing.
func release(ctx context.Context, name, owner string) (bool, error) {
	// TODO: releaseScript.Run(ctx, rdb, []string{lockKey(name)}, owner).Int() == 1
	return false, errors.New("not implemented")
}

// extend is true when the lock was held by this owner and now lives ttlMs from now; false otherwise.
func extend(ctx context.Context, name, owner string, ttlMs int64) (bool, error) {
	// TODO: extendScript.Run(ctx, rdb, []string{lockKey(name)}, owner, ttlMs).Int() == 1
	return false, errors.New("not implemented")
}

func main() {
	ctx := context.Background()
	_, _ = acquire(ctx, "job", "a-7f3", 30000)
}
`,
      solution: `// A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it.
package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS[1] = lock:{name}   ARGV[1] = owner
// Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
const releaseLua = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
\`

// KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttl_ms
// Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
const extendLua = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
\`

var (
	releaseScript = redis.NewScript(releaseLua)
	extendScript  = redis.NewScript(extendLua)
)

func lockKey(name string) string { return "lock:" + name }

// acquire is true when this owner now holds lock:{name} for ttlMs; false while anyone holds it.
func acquire(ctx context.Context, name, owner string, ttlMs int64) (bool, error) {
	// SetNX with a duration is SET … NX plus the TTL: PX for sub-second precision, EX for whole seconds.
	return rdb.SetNX(ctx, lockKey(name), owner, time.Duration(ttlMs)*time.Millisecond).Result()
}

// release is true when the lock was held by this owner and is now free; false otherwise, touching nothing.
func release(ctx context.Context, name, owner string) (bool, error) {
	n, err := releaseScript.Run(ctx, rdb, []string{lockKey(name)}, owner).Int()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// extend is true when the lock was held by this owner and now lives ttlMs from now; false otherwise.
func extend(ctx context.Context, name, owner string, ttlMs int64) (bool, error) {
	n, err := extendScript.Run(ctx, rdb, []string{lockKey(name)}, owner, ttlMs).Int()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

func main() {
	ctx := context.Background()
	if ok, err := acquire(ctx, "job", "a-7f3", 30000); err == nil && ok {
		_, _ = extend(ctx, "job", "a-7f3", 30000)
		_, _ = release(ctx, "job", "a-7f3")
	}
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._

/** A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it. */
object LeaseLock {
  val jedis = new JedisPooled("redis", 6379)

  // KEYS[1] = lock:{name}   ARGV[1] = owner
  // Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
  // TODO: GET KEYS[1] == ARGV[1] → return DEL KEYS[1]; the compare and the delete in one script
  val ReleaseLua: String =
    """
      |return 0
      |""".stripMargin

  // KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttlMs
  // Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
  // TODO: GET KEYS[1] == ARGV[1] → return PEXPIRE KEYS[1] ARGV[2]
  val ExtendLua: String =
    """
      |return 0
      |""".stripMargin

  private val releaseSha: String = jedis.scriptLoad(ReleaseLua)
  private val extendSha: String = jedis.scriptLoad(ExtendLua)

  def lockKey(name: String): String = s"lock:$name"

  /** True when this owner now holds lock:{name} for ttlMs; false while anyone holds it. */
  def acquire(name: String, owner: String, ttlMs: Long): Boolean =
    ??? // TODO: one SET with nx() and px(ttlMs); true only when the reply is not null

  /** True when the lock was held by this owner and is now free; false otherwise, touching nothing. */
  def release(name: String, owner: String): Boolean =
    ??? // TODO: evalsha(releaseSha, keys = lockKey(name), args = owner) == 1

  /** True when the lock was held by this owner and now lives ttlMs from now; false otherwise. */
  def extend(name: String, owner: String, ttlMs: Long): Boolean =
    ??? // TODO: evalsha(extendSha, keys = lockKey(name), args = owner, ttlMs) == 1
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._

/** A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it. */
object LeaseLock {
  val jedis = new JedisPooled("redis", 6379)

  // KEYS[1] = lock:{name}   ARGV[1] = owner
  // Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
  val ReleaseLua: String =
    """
      |if redis.call('GET', KEYS[1]) == ARGV[1] then
      |  return redis.call('DEL', KEYS[1])
      |end
      |return 0
      |""".stripMargin

  // KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttlMs
  // Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
  val ExtendLua: String =
    """
      |if redis.call('GET', KEYS[1]) == ARGV[1] then
      |  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
      |end
      |return 0
      |""".stripMargin

  private val releaseSha: String = jedis.scriptLoad(ReleaseLua)
  private val extendSha: String = jedis.scriptLoad(ExtendLua)

  def lockKey(name: String): String = s"lock:$name"

  /** True when this owner now holds lock:{name} for ttlMs; false while anyone holds it. */
  def acquire(name: String, owner: String, ttlMs: Long): Boolean =
    jedis.set(lockKey(name), owner, SetParams.setParams().nx().px(ttlMs)) != null

  /** True when the lock was held by this owner and is now free; false otherwise, touching nothing. */
  def release(name: String, owner: String): Boolean =
    jedis.evalsha(releaseSha, List(lockKey(name)).asJava, List(owner).asJava).asInstanceOf[Long] == 1L

  /** True when the lock was held by this owner and now lives ttlMs from now; false otherwise. */
  def extend(name: String, owner: String, ttlMs: Long): Boolean =
    jedis.evalsha(extendSha, List(lockKey(name)).asJava, List(owner, ttlMs.toString).asJava).asInstanceOf[Long] == 1L
}
`,
    },
    cpp: {
      starter: `// A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] = lock:{name}   ARGV[1] = owner
// Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
// TODO: GET KEYS[1] == ARGV[1] → return DEL KEYS[1]; the compare and the delete in one script
const std::string kReleaseLua = R"lua(
return 0
)lua";

// KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttl_ms
// Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
// TODO: GET KEYS[1] == ARGV[1] → return PEXPIRE KEYS[1] ARGV[2]
const std::string kExtendLua = R"lua(
return 0
)lua";

const std::string release_sha = redis.script_load(kReleaseLua);
const std::string extend_sha = redis.script_load(kExtendLua);

std::string lock_key(const std::string& name) { return "lock:" + name; }

// True when this owner now holds lock:{name} for ttl_ms; false while anyone holds it.
bool acquire(const std::string& name, const std::string& owner, long long ttl_ms) {
  // TODO: one SET with NOT_EXIST and a millisecond TTL; true only when it happened
  throw std::logic_error("not implemented");
}

// True when the lock was held by this owner and is now free; false otherwise, touching nothing.
bool release(const std::string& name, const std::string& owner) {
  // TODO: evalsha<long long>(release_sha, keys = {lock_key(name)}, args = {owner}) == 1
  throw std::logic_error("not implemented");
}

// True when the lock was held by this owner and now lives ttl_ms from now; false otherwise.
bool extend(const std::string& name, const std::string& owner, long long ttl_ms) {
  // TODO: evalsha<long long>(extend_sha, keys = {lock_key(name)}, args = {owner, ttl_ms}) == 1
  throw std::logic_error("not implemented");
}
`,
      solution: `// A lock with a lease: SET NX PX to take it, compare-and-delete to give it back, compare-and-PEXPIRE to keep it.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] = lock:{name}   ARGV[1] = owner
// Deletes the lock only while it still belongs to this owner; 1 when it did, 0 otherwise.
const std::string kReleaseLua = R"lua(
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
)lua";

// KEYS[1] = lock:{name}   ARGV[1] = owner   ARGV[2] = ttl_ms
// Pushes the lease only while the lock still belongs to this owner; 1 when it did, 0 otherwise.
const std::string kExtendLua = R"lua(
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
)lua";

const std::string release_sha = redis.script_load(kReleaseLua);
const std::string extend_sha = redis.script_load(kExtendLua);

std::string lock_key(const std::string& name) { return "lock:" + name; }

// True when this owner now holds lock:{name} for ttl_ms; false while anyone holds it.
bool acquire(const std::string& name, const std::string& owner, long long ttl_ms) {
  return redis.set(lock_key(name), owner, std::chrono::milliseconds(ttl_ms), sw::redis::UpdateType::NOT_EXIST);
}

// True when the lock was held by this owner and is now free; false otherwise, touching nothing.
bool release(const std::string& name, const std::string& owner) {
  const std::vector<std::string> keys{lock_key(name)}, args{owner};
  return redis.evalsha<long long>(release_sha, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// True when the lock was held by this owner and now lives ttl_ms from now; false otherwise.
bool extend(const std::string& name, const std::string& owner, long long ttl_ms) {
  const std::vector<std::string> keys{lock_key(name)}, args{owner, std::to_string(ttl_ms)};
  return redis.evalsha<long long>(extend_sha, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}
`,
    },
  },
  harness: {
    python: `LOCK = "lock:job"


def check_mutual_exclusion(ctx):
    m = ctx.load("lease_lock")
    assert m.acquire("job", "owner-a", 30_000) is True, "the first acquire of a free lock must return True (a bool, not the raw reply)"
    assert ctx.redis.get(LOCK) == "owner-a", f"{LOCK} holds {ctx.redis.get(LOCK)!r}, expected the owner string owner-a"
    assert m.acquire("job", "owner-b", 30_000) is False, "a second owner must be refused while the lock is held: acquire must return False"
    assert ctx.redis.get(LOCK) == "owner-a", "a refused acquire must not overwrite the holder: SET needs NX"
    assert m.acquire("job", "owner-a", 30_000) is False, "the lock is not reentrant: the holder's own second acquire is refused too (NX sees a key)"
    assert m.acquire("report", "owner-b", 30_000) is True, "a different name is a different lock: lock:report is free"
    assert sorted(ctx.redis.keys("*")) == ["lock:job", "lock:report"], f"expected exactly lock:job and lock:report, found {sorted(ctx.redis.keys('*'))}"


def check_lease_ttl(ctx):
    m = ctx.load("lease_lock")
    assert m.acquire("job", "owner-a", 1500) is True
    pttl = ctx.redis.pttl(LOCK)
    assert 1400 <= pttl <= 1500, f"{LOCK} has PTTL {pttl} ms, expected PX 1500: the lease is ttl_ms milliseconds, set in the same SET"
    ctx.clock.advance(1.0)
    assert m.acquire("job", "owner-b", 1500) is False, "at 1.0 s the 1.5 s lease is still running: owner-b must be refused"
    assert ctx.redis.get(LOCK) == "owner-a"
    ctx.clock.advance(0.6)
    assert m.acquire("job", "owner-b", 1500) is True, "once the lease has elapsed the lock is free: owner-b must get it without anyone releasing"
    assert ctx.redis.get(LOCK) == "owner-b", f"{LOCK} holds {ctx.redis.get(LOCK)!r}, expected the new owner owner-b"
    pttl = ctx.redis.pttl(LOCK)
    assert 1400 <= pttl <= 1500, f"the new holder gets a fresh lease: PTTL is {pttl} ms, expected 1500"


def check_release_owner_only(ctx):
    m = ctx.load("lease_lock")
    assert m.acquire("job", "owner-a", 30_000) is True
    assert m.release("job", "owner-b") is False, "owner-b never held lock:job: release must return False"
    assert ctx.redis.get(LOCK) == "owner-a", "a non-owner's release must leave the lock exactly as it was — a plain DEL frees whoever holds it"
    pttl = ctx.redis.pttl(LOCK)
    assert 29_000 <= pttl <= 30_000, f"a non-owner's release must not touch the lease either: PTTL is {pttl} ms, expected about 30000"
    assert m.release("job", "owner-a") is True, "the owner's release must return True"
    assert ctx.redis.get(LOCK) is None, f"after the owner's release {LOCK} must be gone, it holds {ctx.redis.get(LOCK)!r}"
    assert m.release("job", "owner-a") is False, "releasing a lock you no longer hold returns False"
    # The classic bug: A's lease ran out, B took the lock, and A's late release lands.
    assert m.acquire("job", "owner-a", 1000) is True
    ctx.clock.advance(1.2)
    assert m.acquire("job", "owner-b", 30_000) is True, "A's lease ran out: B must get the lock"
    assert m.release("job", "owner-a") is False, "A's lease ran out and B holds the lock: A's late release must return False"
    assert ctx.redis.get(LOCK) == "owner-b", f"A's late release deleted B's lock ({LOCK} holds {ctx.redis.get(LOCK)!r}): compare the value to the owner before deleting"
    pttl = ctx.redis.pttl(LOCK)
    assert 29_000 <= pttl <= 30_000, f"B's lease must be intact after A's refused release: PTTL is {pttl} ms"


def check_extend_owner_only(ctx):
    m = ctx.load("lease_lock")
    assert m.acquire("job", "owner-a", 2000) is True
    ctx.clock.advance(1.5)
    assert m.extend("job", "owner-b", 10_000) is False, "owner-b does not hold lock:job: extend must return False"
    pttl = ctx.redis.pttl(LOCK)
    assert 400 <= pttl <= 500, f"a non-owner's extend must not move the lease: PTTL is {pttl} ms, expected about 500 (2000 - 1500)"
    assert ctx.redis.get(LOCK) == "owner-a", f"a non-owner's extend must not change the holder: {LOCK} holds {ctx.redis.get(LOCK)!r}"
    assert m.extend("job", "owner-a", 10_000) is True, "the owner's extend must return True"
    pttl = ctx.redis.pttl(LOCK)
    assert 9_900 <= pttl <= 10_000, f"the owner's extend sets the lease to ttl_ms from now: PTTL is {pttl} ms, expected 10000 (PEXPIRE, not added to the remainder)"
    assert ctx.redis.get(LOCK) == "owner-a", "extend must keep the holder"
    ctx.clock.advance(1.0)
    assert ctx.redis.get(LOCK) == "owner-a", "the extended lease carries past where the original 2 s one ended"
    assert m.acquire("job", "owner-b", 1000) is False, "owner-b is still refused: the lease was extended"
    assert m.extend("ghost", "owner-a", 10_000) is False, "extending a lock nobody holds returns False"
    assert ctx.redis.exists("lock:ghost") == 0, "extend must never create a lock: lock:ghost exists"
    ctx.clock.advance(10)
    assert ctx.redis.get(LOCK) is None
    assert m.extend("job", "owner-a", 10_000) is False, "a lease that already ran out cannot be revived: extend must return False"
    assert ctx.redis.exists(LOCK) == 0, f"a refused extend must not recreate {LOCK}"


def check_release_atomic(ctx):
    m = ctx.load("lease_lock")
    assert m.acquire("job", "owner-a", 30_000) is True
    # Right after release's first command on lock:job — the GET, if it is a separate command — A's
    # lease lapses (a GC pause, a slow network) and owner-b takes the lock. A script runs GET and DEL
    # as one unit, so the takeover lands after both; two commands leave a gap the takeover falls into.
    def takeover():
        ctx.clock.advance(31)
        return ctx.redis.set(LOCK, "owner-b", nx=True, px=30_000)

    probe = ctx.redis_after(LOCK, takeover)
    m.release("job", "owner-a")
    assert probe.fired, f"release never touched {LOCK}: the compare-and-delete must run against lock:{{name}}"
    assert probe.result, "owner-b's SET NX PX right after release's first command must have succeeded (the lock was free or deleted at that instant)"
    holder = ctx.redis.get(LOCK)
    assert holder == "owner-b", f"owner-b took the lock after release's first command, yet {LOCK} now holds {holder!r}: a client-side GET then DEL deleted B's lock. Compare and delete in one Lua script"
    pttl = ctx.redis.pttl(LOCK)
    assert 29_000 <= pttl <= 30_000, f"B's fresh lease must be intact: PTTL is {pttl} ms"
`,
    typescript: `const LOCK = 'lock:job';

export async function check_mutual_exclusion(ctx) {
  const m = ctx.load('lease_lock');
  assert.equal(await m.acquire('job', 'owner-a', 30_000), true, 'the first acquire of a free lock must resolve true (a boolean, not the raw reply)');
  assert.equal(ctx.redis.get(LOCK), 'owner-a', \`\${LOCK} holds \${JSON.stringify(ctx.redis.get(LOCK))}, expected the owner string owner-a\`);
  assert.equal(await m.acquire('job', 'owner-b', 30_000), false, 'a second owner must be refused while the lock is held: acquire must resolve false');
  assert.equal(ctx.redis.get(LOCK), 'owner-a', 'a refused acquire must not overwrite the holder: SET needs NX');
  assert.equal(await m.acquire('job', 'owner-a', 30_000), false, "the lock is not reentrant: the holder's own second acquire is refused too (NX sees a key)");
  assert.equal(await m.acquire('report', 'owner-b', 30_000), true, 'a different name is a different lock: lock:report is free');
  const keys = [...(ctx.redis.keys('*') as string[])].sort();
  assert.deepEqual(keys, ['lock:job', 'lock:report'], \`expected exactly lock:job and lock:report, found \${JSON.stringify(keys)}\`);
}

export async function check_lease_ttl(ctx) {
  const m = ctx.load('lease_lock');
  assert.equal(await m.acquire('job', 'owner-a', 1500), true);
  let pttl = Number(ctx.redis.pttl(LOCK));
  assert(1400 <= pttl && pttl <= 1500, \`\${LOCK} has PTTL \${pttl} ms, expected PX 1500: the lease is ttlMs milliseconds, set in the same SET\`);
  ctx.clock.advance(1.0);
  assert.equal(await m.acquire('job', 'owner-b', 1500), false, 'at 1.0 s the 1.5 s lease is still running: owner-b must be refused');
  assert.equal(ctx.redis.get(LOCK), 'owner-a');
  ctx.clock.advance(0.6);
  assert.equal(await m.acquire('job', 'owner-b', 1500), true, 'once the lease has elapsed the lock is free: owner-b must get it without anyone releasing');
  assert.equal(ctx.redis.get(LOCK), 'owner-b', \`\${LOCK} holds \${JSON.stringify(ctx.redis.get(LOCK))}, expected the new owner owner-b\`);
  pttl = Number(ctx.redis.pttl(LOCK));
  assert(1400 <= pttl && pttl <= 1500, \`the new holder gets a fresh lease: PTTL is \${pttl} ms, expected 1500\`);
}

export async function check_release_owner_only(ctx) {
  const m = ctx.load('lease_lock');
  assert.equal(await m.acquire('job', 'owner-a', 30_000), true);
  assert.equal(await m.release('job', 'owner-b'), false, 'owner-b never held lock:job: release must resolve false');
  assert.equal(ctx.redis.get(LOCK), 'owner-a', "a non-owner's release must leave the lock exactly as it was — a plain DEL frees whoever holds it");
  let pttl = Number(ctx.redis.pttl(LOCK));
  assert(29_000 <= pttl && pttl <= 30_000, \`a non-owner's release must not touch the lease either: PTTL is \${pttl} ms, expected about 30000\`);
  assert.equal(await m.release('job', 'owner-a'), true, "the owner's release must resolve true");
  assert.equal(ctx.redis.get(LOCK), null, \`after the owner's release \${LOCK} must be gone, it holds \${JSON.stringify(ctx.redis.get(LOCK))}\`);
  assert.equal(await m.release('job', 'owner-a'), false, 'releasing a lock you no longer hold resolves false');
  // The classic bug: A's lease ran out, B took the lock, and A's late release lands.
  assert.equal(await m.acquire('job', 'owner-a', 1000), true);
  ctx.clock.advance(1.2);
  assert.equal(await m.acquire('job', 'owner-b', 30_000), true, "A's lease ran out: B must get the lock");
  assert.equal(await m.release('job', 'owner-a'), false, "A's lease ran out and B holds the lock: A's late release must resolve false");
  assert.equal(ctx.redis.get(LOCK), 'owner-b', \`A's late release deleted B's lock (\${LOCK} holds \${JSON.stringify(ctx.redis.get(LOCK))}): compare the value to the owner before deleting\`);
  pttl = Number(ctx.redis.pttl(LOCK));
  assert(29_000 <= pttl && pttl <= 30_000, \`B's lease must be intact after A's refused release: PTTL is \${pttl} ms\`);
}

export async function check_extend_owner_only(ctx) {
  const m = ctx.load('lease_lock');
  assert.equal(await m.acquire('job', 'owner-a', 2000), true);
  ctx.clock.advance(1.5);
  assert.equal(await m.extend('job', 'owner-b', 10_000), false, 'owner-b does not hold lock:job: extend must resolve false');
  let pttl = Number(ctx.redis.pttl(LOCK));
  assert(400 <= pttl && pttl <= 500, \`a non-owner's extend must not move the lease: PTTL is \${pttl} ms, expected about 500 (2000 - 1500)\`);
  assert.equal(ctx.redis.get(LOCK), 'owner-a', \`a non-owner's extend must not change the holder: \${LOCK} holds \${JSON.stringify(ctx.redis.get(LOCK))}\`);
  assert.equal(await m.extend('job', 'owner-a', 10_000), true, "the owner's extend must resolve true");
  pttl = Number(ctx.redis.pttl(LOCK));
  assert(9_900 <= pttl && pttl <= 10_000, \`the owner's extend sets the lease to ttlMs from now: PTTL is \${pttl} ms, expected 10000 (PEXPIRE, not added to the remainder)\`);
  assert.equal(ctx.redis.get(LOCK), 'owner-a', 'extend must keep the holder');
  ctx.clock.advance(1.0);
  assert.equal(ctx.redis.get(LOCK), 'owner-a', 'the extended lease carries past where the original 2 s one ended');
  assert.equal(await m.acquire('job', 'owner-b', 1000), false, 'owner-b is still refused: the lease was extended');
  assert.equal(await m.extend('ghost', 'owner-a', 10_000), false, 'extending a lock nobody holds resolves false');
  assert.equal(Number(ctx.redis.exists('lock:ghost')), 0, 'extend must never create a lock: lock:ghost exists');
  ctx.clock.advance(10);
  assert.equal(ctx.redis.get(LOCK), null);
  assert.equal(await m.extend('job', 'owner-a', 10_000), false, 'a lease that already ran out cannot be revived: extend must resolve false');
  assert.equal(Number(ctx.redis.exists(LOCK)), 0, \`a refused extend must not recreate \${LOCK}\`);
}

export async function check_release_atomic(ctx) {
  const m = ctx.load('lease_lock');
  assert.equal(await m.acquire('job', 'owner-a', 30_000), true);
  // Right after release's first command on lock:job — the GET, if it is a separate command — A's
  // lease lapses (a GC pause, a slow network) and owner-b takes the lock. A script runs GET and DEL
  // as one unit, so the takeover lands after both; two commands leave a gap the takeover falls into.
  const probe = ctx.redisAfter(LOCK, () => {
    ctx.clock.advance(31);
    return ctx.redis.set(LOCK, 'owner-b', 'PX', 30_000, 'NX');
  });
  await m.release('job', 'owner-a');
  assert(probe.fired, \`release never touched \${LOCK}: the compare-and-delete must run against lock:\\\${name}\`);
  assert.equal(probe.result, 'OK', "owner-b's SET NX PX right after release's first command must have succeeded (the lock was free or deleted at that instant)");
  const holder = ctx.redis.get(LOCK);
  assert.equal(holder, 'owner-b', \`owner-b took the lock after release's first command, yet \${LOCK} now holds \${JSON.stringify(holder)}: a client-side GET then DEL deleted B's lock. Compare and delete in one Lua script\`);
  const pttl = Number(ctx.redis.pttl(LOCK));
  assert(29_000 <= pttl && pttl <= 30_000, \`B's fresh lease must be intact: PTTL is \${pttl} ms\`);
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"
)

const lock = "lock:job"

var bg = context.Background()

func acq(ctx *harness.Ctx, name, owner string, ttlMs int64) bool {
	ok, err := acquire(bg, name, owner, ttlMs)
	ctx.NoError(err, "acquire(%q, %q, %d) returned an error", name, owner, ttlMs)
	return ok
}

func rel(ctx *harness.Ctx, name, owner string) bool {
	ok, err := release(bg, name, owner)
	ctx.NoError(err, "release(%q, %q) returned an error", name, owner)
	return ok
}

func ext(ctx *harness.Ctx, name, owner string, ttlMs int64) bool {
	ok, err := extend(bg, name, owner, ttlMs)
	ctx.NoError(err, "extend(%q, %q, %d) returned an error", name, owner, ttlMs)
	return ok
}

func holder(ctx *harness.Ctx) any {
	if v, ok := ctx.Redis.Get(lock); ok {
		return v
	}
	return nil
}

func CheckMutualExclusion(ctx *harness.Ctx) {
	ctx.Equal(acq(ctx, "job", "owner-a", 30_000), true, "the first acquire of a free lock must return true")
	ctx.Equal(holder(ctx), "owner-a", "lock:job must hold the owner string")
	ctx.Equal(acq(ctx, "job", "owner-b", 30_000), false, "a second owner must be refused while the lock is held: acquire must return false")
	ctx.Equal(holder(ctx), "owner-a", "a refused acquire must not overwrite the holder: SET needs NX")
	ctx.Equal(acq(ctx, "job", "owner-a", 30_000), false, "the lock is not reentrant: the holder's own second acquire is refused too (NX sees a key)")
	ctx.Equal(acq(ctx, "report", "owner-b", 30_000), true, "a different name is a different lock: lock:report is free")
	ctx.Equal(ctx.Redis.Keys("*"), []string{"lock:job", "lock:report"}, "the keys in Redis")
}

func CheckLeaseTtl(ctx *harness.Ctx) {
	ctx.Equal(acq(ctx, "job", "owner-a", 1500), true, "acquire of a free lock")
	pttl := ctx.Redis.PTTL(lock)
	ctx.Assert(1400 <= pttl && pttl <= 1500, "lock:job has PTTL %d ms, expected PX 1500: the lease is ttlMs milliseconds, set in the same SET", pttl)
	ctx.Clock.Advance(1.0)
	ctx.Equal(acq(ctx, "job", "owner-b", 1500), false, "at 1.0 s the 1.5 s lease is still running: owner-b must be refused")
	ctx.Equal(holder(ctx), "owner-a", "the holder at 1.0 s")
	ctx.Clock.Advance(0.6)
	ctx.Equal(acq(ctx, "job", "owner-b", 1500), true, "once the lease has elapsed the lock is free: owner-b must get it without anyone releasing")
	ctx.Equal(holder(ctx), "owner-b", "lock:job must hold the new owner")
	pttl = ctx.Redis.PTTL(lock)
	ctx.Assert(1400 <= pttl && pttl <= 1500, "the new holder gets a fresh lease: PTTL is %d ms, expected 1500", pttl)
}

func CheckReleaseOwnerOnly(ctx *harness.Ctx) {
	ctx.Equal(acq(ctx, "job", "owner-a", 30_000), true, "acquire of a free lock")
	ctx.Equal(rel(ctx, "job", "owner-b"), false, "owner-b never held lock:job: release must return false")
	ctx.Equal(holder(ctx), "owner-a", "a non-owner's release must leave the lock exactly as it was (a plain DEL frees whoever holds it)")
	pttl := ctx.Redis.PTTL(lock)
	ctx.Assert(29_000 <= pttl && pttl <= 30_000, "a non-owner's release must not touch the lease either: PTTL is %d ms, expected about 30000", pttl)
	ctx.Equal(rel(ctx, "job", "owner-a"), true, "the owner's release must return true")
	ctx.Equal(holder(ctx), nil, "after the owner's release lock:job must be gone")
	ctx.Equal(rel(ctx, "job", "owner-a"), false, "releasing a lock you no longer hold returns false")
	// The classic bug: A's lease ran out, B took the lock, and A's late release lands.
	ctx.Equal(acq(ctx, "job", "owner-a", 1000), true, "acquire with a 1 s lease")
	ctx.Clock.Advance(1.2)
	ctx.Equal(acq(ctx, "job", "owner-b", 30_000), true, "A's lease ran out: B must get the lock")
	ctx.Equal(rel(ctx, "job", "owner-a"), false, "A's lease ran out and B holds the lock: A's late release must return false")
	ctx.Equal(holder(ctx), "owner-b", "A's late release must not delete B's lock: compare the value to the owner before deleting")
	pttl = ctx.Redis.PTTL(lock)
	ctx.Assert(29_000 <= pttl && pttl <= 30_000, "B's lease must be intact after A's refused release: PTTL is %d ms", pttl)
}

func CheckExtendOwnerOnly(ctx *harness.Ctx) {
	ctx.Equal(acq(ctx, "job", "owner-a", 2000), true, "acquire with a 2 s lease")
	ctx.Clock.Advance(1.5)
	ctx.Equal(ext(ctx, "job", "owner-b", 10_000), false, "owner-b does not hold lock:job: extend must return false")
	pttl := ctx.Redis.PTTL(lock)
	ctx.Assert(400 <= pttl && pttl <= 500, "a non-owner's extend must not move the lease: PTTL is %d ms, expected about 500 (2000 - 1500)", pttl)
	ctx.Equal(holder(ctx), "owner-a", "a non-owner's extend must not change the holder")
	ctx.Equal(ext(ctx, "job", "owner-a", 10_000), true, "the owner's extend must return true")
	pttl = ctx.Redis.PTTL(lock)
	ctx.Assert(9_900 <= pttl && pttl <= 10_000, "the owner's extend sets the lease to ttlMs from now: PTTL is %d ms, expected 10000 (PEXPIRE, not added to the remainder)", pttl)
	ctx.Equal(holder(ctx), "owner-a", "extend must keep the holder")
	ctx.Clock.Advance(1.0)
	ctx.Equal(holder(ctx), "owner-a", "the extended lease carries past where the original 2 s one ended")
	ctx.Equal(acq(ctx, "job", "owner-b", 1000), false, "owner-b is still refused: the lease was extended")
	ctx.Equal(ext(ctx, "ghost", "owner-a", 10_000), false, "extending a lock nobody holds returns false")
	ctx.Equal(ctx.Redis.Exists("lock:ghost"), 0, "extend must never create a lock: lock:ghost exists")
	ctx.Clock.Advance(10)
	ctx.Equal(holder(ctx), nil, "the lease ran out")
	ctx.Equal(ext(ctx, "job", "owner-a", 10_000), false, "a lease that already ran out cannot be revived: extend must return false")
	ctx.Equal(ctx.Redis.Exists(lock), 0, "a refused extend must not recreate lock:job")
}

func CheckReleaseAtomic(ctx *harness.Ctx) {
	ctx.Equal(acq(ctx, "job", "owner-a", 30_000), true, "acquire of a free lock")
	// Right after release's first command on lock:job (the GET, if it is a separate command) A's
	// lease lapses (a GC pause, a slow network) and owner-b takes the lock. A script runs GET and DEL
	// as one unit, so the takeover lands after both; two commands leave a gap the takeover falls into.
	probe := ctx.Redis.After(lock, func() any {
		ctx.Clock.Advance(31)
		return ctx.Redis.Set(lock, "owner-b", "PX", 30_000, "NX")
	})
	_, _ = release(bg, "job", "owner-a")
	ctx.Assert(probe.Fired, "release never touched lock:job: the compare-and-delete must run against lock:{name}")
	ctx.Equal(probe.Result, true, "owner-b's SET NX PX right after release's first command must have succeeded (the lock was free or deleted at that instant)")
	ctx.Equal(holder(ctx), "owner-b", "owner-b took the lock after release's first command, so it must still hold it: a client-side GET then DEL deleted B's lock. Compare and delete in one Lua script")
	pttl := ctx.Redis.PTTL(lock)
	ctx.Assert(29_000 <= pttl && pttl <= 30_000, "B's fresh lease must be intact: PTTL is %d ms", pttl)
}
`,
  },
  debrief: `Three commands carry the whole contract. \`SET NX PX\` makes taking the lock and bounding it one write, so a worker that dies a microsecond later still leaves a key that frees itself — \`SETNX\` followed by \`PEXPIRE\` does not, and that gap is where "stuck forever" locks come from. The owner value turns every later write into a compare-and-write: \`release\` and \`extend\` read the key and act only if it still names the caller, and because Redis runs a Lua script without interleaving other clients, the read and the write see the same world. Done as two commands from the client, the lease can lapse between them and the \`DEL\` lands on the next owner's lock — the race the last check reproduces, and the reason a plain \`DEL\` is wrong even when "we only delete our own locks" is the policy. Real systems add a heartbeat that calls \`extend\` well before the lease ends, a fencing token (a counter handed out with the lock and checked by the resource the lock protects, since a paused holder may still act after its lease ran out), and, when a single Redis is not trustworthy enough, Redlock across several instances or a consensus store.`,
};
