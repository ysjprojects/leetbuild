import type {Step} from '@/lib/types';

export const cooldownStep: Step = {
  id: 'cooldown',
  title: 'One tile per user per five minutes, atomically',
  concept: 'redis',
  file: 'cooldown',
  focus: ['api', 'redis'],
  task: `## Task

Implement \`place_tile(user, x, y, color) -> int\`: paint the pixel unless the user placed one less than
**\`COOLDOWN_S\`** (300) seconds ago, and return how many seconds they still have to wait — **0** when the
tile was painted.

- The cooldown is one key per user, \`cooldown:{user}\`, written with **\`SET … NX EX 300\`**. The
  reply tells you everything: set → the user was free and is now on cooldown; not set → refuse.
- Refused → \`TTL cooldown:{user}\`, returned as the seconds to wait (at least 1).
- Accepted → \`SETRANGE board <y * SIZE + x> <one byte: color>\`. No read, no lock: Redis writes the byte in
  place and zero-fills anything before it on a fresh key.
- Never \`GET\`/\`EXISTS\` the cooldown key and then \`SET\` it. Reddit did the check and the write as
  separate steps and about 15 000 tiles (0.09 %) slipped through the gap from bots firing requests in
  parallel; \`NX\` closes it in one round trip.
- Check **before** you paint: a cooldown claimed for a tile that was never painted costs one user one
  turn; a tile painted by a user who should have been refused is what everyone else sees.

> \`SET NX EX\` is a lock whose expiry *is* the business rule. The same shape protects "one email per
> signup", "one job per minute per tenant" and "one retry in flight".`,
  sequence: {
    participants: ['place-api', 'Redis'],
    messages: [
      {from: 'place-api', to: 'Redis', label: 'SET cooldown:ana 1 NX EX 300', kind: 'sync'},
      {from: 'Redis', to: 'place-api', label: 'OK', kind: 'reply'},
      {from: 'place-api', to: 'Redis', label: 'SETRANGE board 703 0x0c', kind: 'sync'},
      {from: 'Redis', to: 'place-api', label: '10 000 (new length)', kind: 'reply'},
      {from: 'place-api', to: 'Redis', label: 'SET cooldown:ana 1 NX EX 300  (100 s later)', kind: 'sync'},
      {from: 'Redis', to: 'place-api', label: '(nil) — key exists', kind: 'reply'},
      {from: 'place-api', to: 'Redis', label: 'TTL cooldown:ana', kind: 'sync'},
      {from: 'Redis', to: 'place-api', label: '200', kind: 'reply'},
    ],
  },
  hints: [
    'redis-py: `r.set(key, 1, nx=True, ex=COOLDOWN_S)` returns `True` when it set the key and `None` when the key already existed. That one return value is the whole cooldown check.',
    'The pixel byte is `bytes([color])`; the offset is `y * SIZE + x` (row-major, like the board endpoint reads it). SETRANGE on a missing key creates it, zero-padded up to the offset.',
    'TTL can read -2 if the key expired between the SET and the TTL; `max(1, ttl)` keeps the answer honest. The order is SET NX first, SETRANGE second — a refused user must not touch the board.',
  ],
  checks: [
    {
      id: 'cooldown-key',
      title: 'One cooldown key per user with a 300 s expiry',
      detail: 'The key is `cooldown:{user}` and it expires after `COOLDOWN_S` (300) seconds.',
      match: {
        python: {all: [/f["']cooldown:\{user\}["']/, /COOLDOWN_S\s*=\s*300|ex\s*=\s*300/]},
        go: {all: [/"cooldown:"\s*\+\s*user/, /cooldown\s*=\s*300\s*\*\s*time\.Second|300\s*\*\s*time\.Second/]},
        scala: {all: [/s"cooldown:\$\{?user\}?"/, /CooldownSeconds\s*=\s*300L?|\.ex\(\s*300/]},
        cpp: {all: [/"cooldown:"\s*\+\s*user/, /kCooldownS\{?\s*\(?\s*300|seconds\{?\(?\s*300/]},
      },
    },
    {
      id: 'atomic-nx',
      title: 'Claims the cooldown with SET NX EX, never GET then SET',
      detail:
        'One `SET cooldown:{user} … NX EX 300` both checks and claims the cooldown; its reply decides. A `GET`/`EXISTS` followed by a `SET` lets parallel requests all pass the check.',
      match: {
        python: {
          all: [
            /\.set\([^\n]*nx\s*=\s*True[^\n]*ex\s*=\s*(COOLDOWN_S|300)|\.set\([^\n]*ex\s*=\s*(COOLDOWN_S|300)[^\n]*nx\s*=\s*True/,
          ],
          none: [/\br\.(get|exists|mget)\(/],
        },
        go: {all: [/rdb\.SetNX\(\s*ctx\s*,\s*key\s*,[^\n]*cooldown\)/], none: [/rdb\.(Get|Exists)\(/]},
        scala: {all: [/\.nx\(\)/, /\.ex\(\s*(CooldownSeconds|300)/], none: [/jedis\.(get|exists)\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/, /kCooldownS/], none: [/redis\.(get|exists)\(/]},
      },
    },
    {
      id: 'paint',
      title: 'Paints with SETRANGE at y * SIZE + x',
      detail:
        'An accepted placement writes exactly one byte, the colour, at offset `y * SIZE + x` of the `board` string with `SETRANGE` — no read-modify-write of the blob.',
      match: {
        python: {
          all: [
            /\.setrange\(\s*BOARD_KEY\s*,\s*(y\s*\*\s*SIZE\s*\+\s*x|x\s*\+\s*y\s*\*\s*SIZE|SIZE\s*\*\s*y\s*\+\s*x|x\s*\+\s*SIZE\s*\*\s*y)\s*,\s*bytes\(\s*[[(]\s*color/,
          ],
        },
        go: {
          all: [
            /rdb\.SetRange\(\s*ctx\s*,\s*boardKey\s*,\s*int64\(\s*(y\s*\*\s*size\s*\+\s*x|x\s*\+\s*y\s*\*\s*size|size\s*\*\s*y\s*\+\s*x|x\s*\+\s*size\s*\*\s*y)\s*\)\s*,\s*string\(\s*\[\]byte\{\s*byte\(\s*color\s*\)/,
          ],
        },
        scala: {
          all: [
            /jedis\.setrange\(\s*BoardKey\.getBytes\s*,\s*\(?\s*(y\s*\*\s*Size\s*\+\s*x|x\s*\+\s*y\s*\*\s*Size|Size\s*\*\s*y\s*\+\s*x|x\s*\+\s*Size\s*\*\s*y)\s*\)?(\.toLong)?\s*,\s*Array\[Byte\]\(\s*color\.toByte\s*\)/,
          ],
        },
        cpp: {
          all: [
            /redis\.setrange\(\s*kBoardKey\s*,\s*(y\s*\*\s*kSize\s*\+\s*x|x\s*\+\s*y\s*\*\s*kSize|kSize\s*\*\s*y\s*\+\s*x|x\s*\+\s*kSize\s*\*\s*y)\s*,\s*std::string\(\s*1\s*,\s*static_cast<char>\(\s*color\s*\)/,
          ],
        },
      },
    },
    {
      id: 'retry-after',
      title: 'Reports the remaining cooldown from TTL',
      detail:
        'A refused placement returns the key’s `TTL` in seconds (at least 1), which the API turns into `Retry-After`.',
      match: {
        python: {all: [/\br\.ttl\(/, /max\(\s*1\s*,/]},
        go: {all: [/rdb\.TTL\(/, /math\.Max\(\s*1\s*,|Ceil\(/]},
        scala: {all: [/jedis\.ttl\(/, /math\.max\(\s*1L?\s*,/]},
        cpp: {all: [/redis\.ttl\(/, /std::max\(\s*(1L|1LL|1|\{1\})/]},
      },
    },
    {
      id: 'claim-first',
      title: 'Claims the cooldown before painting',
      detail: 'The `SET NX` comes before the `SETRANGE`: a refused user never touches the board.',
      match: {
        python: {order: [/\.set\(/, /\.setrange\(/]},
        go: {order: [/rdb\.SetNX\(/, /rdb\.SetRange\(/]},
        scala: {order: [/jedis\.set\(/, /jedis\.setrange\(/]},
        cpp: {order: [/redis\.set\(/, /redis\.setrange\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379)

SIZE = 100
BOARD_KEY = "board"
COOLDOWN_S = 300  # one tile per user per five minutes


def place_tile(user: str, x: int, y: int, color: int) -> int:
    """Paint (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted."""
    key = f"cooldown:{user}"
    # TODO: SET key 1 NX EX COOLDOWN_S — not set → return max(1, TTL key)
    # TODO: SETRANGE BOARD_KEY (y * SIZE + x) bytes([color]); return 0
    raise NotImplementedError
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379)

SIZE = 100
BOARD_KEY = "board"
COOLDOWN_S = 300  # one tile per user per five minutes


def place_tile(user: str, x: int, y: int, color: int) -> int:
    """Paint (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted."""
    key = f"cooldown:{user}"
    if r.set(key, 1, nx=True, ex=COOLDOWN_S) is None:  # the key exists: still on cooldown
        return max(1, r.ttl(key))
    r.setrange(BOARD_KEY, y * SIZE + x, bytes([color]))  # one byte, in place, no read
    return 0
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	size     = 100
	boardKey = "board"
	cooldown = 300 * time.Second // one tile per user per five minutes
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// placeTile paints (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted.
func placeTile(ctx context.Context, user string, x, y, color int) (int, error) {
	key := "cooldown:" + user
	// TODO: SetNX(key, 1, cooldown) — false → return max(1, ceil(TTL(key)))
	// TODO: SetRange(boardKey, y*size+x, one byte: color); return 0
	_ = key
	_ = math.Ceil
	return 0, nil
}
`,
      solution: `package main

import (
	"context"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	size     = 100
	boardKey = "board"
	cooldown = 300 * time.Second // one tile per user per five minutes
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// placeTile paints (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted.
func placeTile(ctx context.Context, user string, x, y, color int) (int, error) {
	key := "cooldown:" + user
	claimed, err := rdb.SetNX(ctx, key, 1, cooldown).Result() // SET key 1 NX EX 300
	if err != nil {
		return 0, err
	}
	if !claimed { // the key exists: still on cooldown
		ttl, err := rdb.TTL(ctx, key).Result()
		if err != nil {
			return 0, err
		}
		return int(math.Max(1, math.Ceil(ttl.Seconds()))), nil
	}
	// One byte, in place, no read: SETRANGE zero-fills a fresh key up to the offset.
	return 0, rdb.SetRange(ctx, boardKey, int64(y*size+x), string([]byte{byte(color)})).Err()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object Cooldown {
  val Size = 100
  val BoardKey = "board"
  val CooldownSeconds = 300L // one tile per user per five minutes
  val jedis = new JedisPooled("redis", 6379)

  /** Paints (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted. */
  def placeTile(user: String, x: Int, y: Int, color: Int): Int = {
    val key = s"cooldown:$user"
    // TODO: jedis.set(key, "1", SetParams.setParams().nx().ex(CooldownSeconds)) — null → max(1, ttl(key))
    // TODO: jedis.setrange(BoardKey.getBytes, y * Size + x, Array[Byte](color.toByte)); 0
    ???
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object Cooldown {
  val Size = 100
  val BoardKey = "board"
  val CooldownSeconds = 300L // one tile per user per five minutes
  val jedis = new JedisPooled("redis", 6379)

  /** Paints (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted. */
  def placeTile(user: String, x: Int, y: Int, color: Int): Int = {
    val key = s"cooldown:$user"
    val claimed = jedis.set(key, "1", SetParams.setParams().nx().ex(CooldownSeconds)) // "OK" or null
    if (claimed == null) math.max(1L, jedis.ttl(key)).toInt // the key exists: still on cooldown
    else {
      jedis.setrange(BoardKey.getBytes, (y * Size + x).toLong, Array[Byte](color.toByte)) // one byte, in place
      0
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>

constexpr int kSize = 100;
const std::string kBoardKey = "board";
constexpr std::chrono::seconds kCooldownS{300};  // one tile per user per five minutes

sw::redis::Redis redis("tcp://redis:6379");

// Paints (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted.
int place_tile(const std::string& user, int x, int y, int color) {
  const std::string key = "cooldown:" + user;
  // TODO: redis.set(key, "1", kCooldownS, sw::redis::UpdateType::NOT_EXIST) — false → max(1, ttl(key))
  // TODO: redis.setrange(kBoardKey, y * kSize + x, std::string(1, static_cast<char>(color))); return 0
  return 0;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>

constexpr int kSize = 100;
const std::string kBoardKey = "board";
constexpr std::chrono::seconds kCooldownS{300};  // one tile per user per five minutes

sw::redis::Redis redis("tcp://redis:6379");

// Paints (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted.
int place_tile(const std::string& user, int x, int y, int color) {
  const std::string key = "cooldown:" + user;
  if (!redis.set(key, "1", kCooldownS, sw::redis::UpdateType::NOT_EXIST))  // SET key 1 EX 300 NX
    return static_cast<int>(std::max(1LL, redis.ttl(key)));                 // the key exists: still on cooldown
  redis.setrange(kBoardKey, y * kSize + x, std::string(1, static_cast<char>(color)));  // one byte, in place
  return 0;
}
`,
    },
  },
  harness: {
    python: `def _cooldown(ctx):
    """The learner's module with every Redis command it sends recorded as (NAME, args…)."""
    m = ctx.load("cooldown")
    m.commands = []
    original = m.r.execute_command

    def recording(*args, **kwargs):
        m.commands.append(tuple(str(a).upper() if i == 0 else str(a) for i, a in enumerate(args)))
        return original(*args, **kwargs)

    m.r.execute_command = recording
    return m


def _board(ctx):
    return ctx.redis_bytes.get("board") or b""


def check_cooldown_key(ctx):
    m = _cooldown(ctx)
    assert m.place_tile("ana", 3, 7, 12) == 0, "a user who never placed a tile is free: place_tile must return 0"
    assert ctx.redis.exists("cooldown:ana") == 1, f"after a placement the key cooldown:ana must exist (keys: {ctx.redis.keys()})"
    ttl = ctx.redis.ttl("cooldown:ana")
    assert 295 <= ttl <= 300, f"cooldown:ana expires in {ttl} s, expected COOLDOWN_S = 300"
    assert m.place_tile("bo", 3, 8, 1) == 0, "the cooldown is per user: bo is not affected by ana's tile"
    ctx.clock.advance(301)
    assert ctx.redis.exists("cooldown:ana") == 0, "cooldown:ana must be gone after 300 s"
    assert m.place_tile("ana", 3, 7, 12) == 0, "once the key expired the user is free again"


def check_atomic_nx(ctx):
    m = _cooldown(ctx)
    m.place_tile("ana", 3, 7, 12)
    sets = [c for c in m.commands if c[0] == "SET" and c[1] == "cooldown:ana"]
    assert sets, f"no SET on cooldown:ana was sent; commands: {m.commands}"
    flags = [a.upper() for a in sets[0][2:]]
    assert "NX" in flags, f"the SET on cooldown:ana was {sets[0]}: without NX it overwrites a running cooldown instead of refusing"
    assert "EX" in flags or "PX" in flags, f"the SET on cooldown:ana was {sets[0]}: without EX the cooldown never ends"
    reads = [c for c in m.commands if c[0] in ("GET", "EXISTS", "MGET") and "cooldown:ana" in c[1:]]
    assert not reads, f"{reads[0][0]} cooldown:ana then SET is a race: two parallel requests both pass the check. Let SET NX decide"
    first = next(c for c in m.commands if c[1:2] == ("cooldown:ana",))
    assert first[0] == "SET", f"the first command on cooldown:ana was {first[0]}, expected the SET NX that both checks and claims"
    wait = m.place_tile("ana", 3, 7, 5)
    assert wait > 0, f"a second tile from the same user within 300 s must be refused, but place_tile returned {wait}"


def check_paint(ctx):
    m = _cooldown(ctx)
    off = 7 * m.SIZE + 3
    m.place_tile("ana", 3, 7, 12)
    board = _board(ctx)
    assert len(board) > off, f"the board key is {len(board)} bytes after painting (3, 7): expected a write at offset y * SIZE + x = {off}"
    assert board[off] == 12, f"byte {off} of the board is {board[off]}, expected the colour 12"
    assert board.count(0) == len(board) - 1, "painting one tile must change exactly one byte"
    m.place_tile("bo", m.SIZE - 1, m.SIZE - 1, 15)
    board = _board(ctx)
    assert len(board) == m.SIZE * m.SIZE, f"after painting the last pixel the board is {len(board)} bytes, expected SIZE * SIZE = {m.SIZE * m.SIZE}"
    assert board[-1] == 15, f"the last byte is {board[-1]}, expected 15"
    m.place_tile("cy", 3, 7, 3)
    assert _board(ctx)[off] == 3, "painting over a pixel replaces its colour"
    assert ctx.redis_bytes.type("board") == b"string", f"board is a {ctx.redis_bytes.type('board')!r}, expected one string"


def check_retry_after(ctx):
    m = _cooldown(ctx)
    m.place_tile("ana", 3, 7, 12)
    ctx.clock.advance(100)
    wait = m.place_tile("ana", 4, 7, 12)
    assert 199 <= wait <= 200, f"100 s into a 300 s cooldown place_tile returned {wait}, expected the TTL (200)"
    ctx.clock.advance(199.5)
    wait = m.place_tile("ana", 4, 7, 12)
    assert wait == 1, f"half a second before the cooldown ends place_tile returned {wait}, expected at least 1"
    ctx.clock.advance(1)
    assert m.place_tile("ana", 4, 7, 12) == 0, "once the cooldown ended the tile must be painted"


async def check_claim_first(ctx):
    m = _cooldown(ctx)
    off = 7 * m.SIZE + 3
    m.place_tile("ana", 3, 7, 12)
    m.commands.clear()
    wait = m.place_tile("ana", 3, 7, 5)
    assert wait > 0, "the second tile within the cooldown must be refused"
    assert _board(ctx)[off] == 12, f"a refused placement painted the board: byte {off} is {_board(ctx)[off]}, expected the earlier 12"
    assert not any(c[0] == "SETRANGE" for c in m.commands), f"a refused placement sent SETRANGE: {m.commands}. Claim the cooldown first, paint second"
    api = ctx.load("board_api")
    async with ctx.client(api.app) as c:
        r = await c.post("/place", json={"x": 3, "y": 7, "color": 5, "user": "ana"})
        assert r.status_code == 429, f"through the API a user on cooldown gets 429, got {r.status_code}"
        assert r.headers.get("retry-after") in ("299", "300"), f"Retry-After is {r.headers.get('retry-after')!r}, expected the TTL (300)"
        r = await c.post("/place", json={"x": 3, "y": 7, "color": 5, "user": "bo"})
        assert r.status_code == 200, f"another user may paint the same pixel: expected 200, got {r.status_code}"
    assert _board(ctx)[off] == 5, "bo's tile must be painted"
`,
  },
  debrief: `The cooldown and the lock are the same key. \`SET NX EX\` answers "was this user free?" and makes them not free in one atomic step, so a thousand parallel requests from one bot produce exactly one tile — the race Reddit shipped with (check in Cassandra, then write, with nothing in between) is simply not expressible here. \`SETRANGE\` is the other half of the design: the board is a flat array in a string, a pixel is one byte at a computed offset, and Redis updates it in place with no read, no lock and no version check, which is why 200 placements per second never contended. Real deployments pack two 4-bit pixels per byte with \`BITFIELD SET u4 #offset\`, keep the per-tile author and timestamp in a wide table for "who placed this?", and make the cooldown adjustable at runtime — Reddit turned the knob several times during the event to shed load.`,
};
