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
        typescript: {
          all: [/`cooldown:\$\{user\}`|['"]cooldown:['"]\s*\+\s*user/, /COOLDOWN_S\s*=\s*300|['"]EX['"]\s*,\s*300/],
        },
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
        typescript: {
          all: [
            /\.set\([^\n]*['"]EX['"]\s*,\s*(COOLDOWN_S|300)[^\n]*['"]NX['"]|\.set\([^\n]*['"]NX['"][^\n]*['"]EX['"]\s*,\s*(COOLDOWN_S|300)/,
          ],
          none: [/\bredis\.(get|exists|mget)\(/],
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
        typescript: {
          all: [
            /\.setrange\(\s*BOARD_KEY\s*,\s*(y\s*\*\s*SIZE\s*\+\s*x|x\s*\+\s*y\s*\*\s*SIZE|SIZE\s*\*\s*y\s*\+\s*x|x\s*\+\s*SIZE\s*\*\s*y)\s*,\s*(Buffer\.from\(\s*\[\s*color|String\.fromCharCode\(\s*color)/,
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
        typescript: {all: [/\bredis\.ttl\(/, /Math\.max\(\s*1\s*,/]},
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
        typescript: {order: [/\.set\(/, /\.setrange\(/]},
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
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SIZE = 100;
export const BOARD_KEY = 'board';
export const COOLDOWN_S = 300; // one tile per user per five minutes

/** Paint (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted. */
export async function placeTile(user: string, x: number, y: number, color: number): Promise<number> {
  const key = \`cooldown:\${user}\`;
  // TODO: SET key 1 EX COOLDOWN_S NX — a null reply → return Math.max(1, TTL key)
  // TODO: SETRANGE BOARD_KEY (y * SIZE + x) Buffer.from([color]); return 0
  throw new Error('not implemented');
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SIZE = 100;
export const BOARD_KEY = 'board';
export const COOLDOWN_S = 300; // one tile per user per five minutes

/** Paint (x, y) for user unless they are on cooldown; returns the seconds left to wait, 0 = painted. */
export async function placeTile(user: string, x: number, y: number, color: number): Promise<number> {
  const key = \`cooldown:\${user}\`;
  const claimed = await redis.set(key, 1, 'EX', COOLDOWN_S, 'NX');
  if (claimed === null) return Math.max(1, await redis.ttl(key)); // the key exists: still on cooldown
  await redis.setrange(BOARD_KEY, y * SIZE + x, Buffer.from([color])); // one byte, in place, no read
  return 0;
}
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
    python: `def _board(ctx):
    return ctx.redis_bytes.get("board") or b""


def _pixel(ctx, m, x, y):
    board = _board(ctx)
    off = y * m.SIZE + x
    return board[off] if off < len(board) else 0


def _settled(probe, what):
    """The parallel request landed and finished: its result, or its own error re-raised."""
    assert probe.fired, f"place_tile never touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_cooldown_key(ctx):
    m = ctx.load("cooldown")
    assert m.place_tile("ana", 3, 7, 12) == 0, "a user who never placed a tile is free: place_tile must return 0"
    assert ctx.redis.exists("cooldown:ana") == 1, f"after a placement the key cooldown:ana must exist (keys: {ctx.redis.keys()})"
    ttl = ctx.redis.ttl("cooldown:ana")
    assert 295 <= ttl <= 300, f"cooldown:ana expires in {ttl} s, expected COOLDOWN_S = 300"
    assert m.place_tile("bo", 3, 8, 1) == 0, "the cooldown is per user: bo is not affected by ana's tile"
    ctx.clock.advance(299)
    assert m.place_tile("ana", 4, 7, 1) > 0, "299 s after her tile ana is still on cooldown: place_tile must refuse"
    ctx.clock.advance(2)
    assert ctx.redis.exists("cooldown:ana") == 0, "cooldown:ana must be gone after 300 s"
    assert m.place_tile("ana", 3, 7, 12) == 0, "once the key expired the user is free again"


def check_atomic_nx(ctx):
    m = ctx.load("cooldown")
    # A bot fires two requests at once; they reach two app servers. The second one runs right after
    # the first one's first command on cooldown:ana, the gap Reddit's check-then-write left open.
    rival = ctx.redis_after("cooldown:ana", lambda: m.place_tile("ana", 4, 7, 5))
    mine = m.place_tile("ana", 3, 7, 12)
    theirs = _settled(rival, "cooldown:ana")
    painted = [wait == 0 for wait in (mine, theirs)]
    assert painted.count(True) == 1, (
        f"two parallel placements by ana returned {mine} and {theirs}: "
        + ("both were painted. A check followed by a separate write lets every parallel request through — about 15 000 tiles slipped past r/place's cooldown that way; let one SET … NX decide" if all(painted) else "neither was painted, but one of them must win")
    )
    won, lost = ((3, 7, 12), (4, 7)) if painted[0] else ((4, 7, 5), (3, 7))
    assert _pixel(ctx, m, won[0], won[1]) == won[2], f"the winning placement returned 0 but ({won[0]}, {won[1]}) shows {_pixel(ctx, m, won[0], won[1])}, expected {won[2]}"
    assert _pixel(ctx, m, *lost) == 0, f"the refused placement painted ({lost[0]}, {lost[1]}) anyway"
    wait = m.place_tile("ana", 5, 7, 1)
    assert wait > 0, f"a later tile from the same user within 300 s must be refused, but place_tile returned {wait}"


def check_paint(ctx):
    m = ctx.load("cooldown")
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
    # 200 placements a second: dee's tile is written while eve's is in progress.
    rival = ctx.redis_after("board", lambda: m.place_tile("dee", 50, 50, 7))
    assert m.place_tile("eve", 10, 10, 9) == 0, "eve is free: her tile must be painted"
    assert _settled(rival, "the board") == 0, "dee is free: her tile must be painted"
    assert _pixel(ctx, m, 10, 10) == 9, f"eve's tile at (10, 10) is {_pixel(ctx, m, 10, 10)}, expected 9"
    assert _pixel(ctx, m, 50, 50) == 7, f"dee's tile at (50, 50), painted while eve's was being written, is {_pixel(ctx, m, 50, 50)} instead of 7: eve's write replaced the board with a copy read before dee painted. Write the one byte in place"
    assert _pixel(ctx, m, m.SIZE - 1, m.SIZE - 1) == 15 and _pixel(ctx, m, 3, 7) == 3, "earlier tiles must survive later ones"


def check_retry_after(ctx):
    m = ctx.load("cooldown")
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
    m = ctx.load("cooldown")
    assert m.place_tile("ana", 3, 7, 12) == 0, "ana is free: her tile must be painted"
    wait = m.place_tile("ana", 3, 7, 5)
    assert wait > 0, "the second tile within the cooldown must be refused"
    assert _pixel(ctx, m, 3, 7) == 12, f"a refused placement painted the board: (3, 7) is {_pixel(ctx, m, 3, 7)}, expected the earlier 12. Claim the cooldown first, paint second"
    # cy's two parallel requests on one pixel: the board must show the one that was accepted.
    rival = ctx.redis_after("cooldown:cy", lambda: m.place_tile("cy", 6, 7, 5))
    mine = m.place_tile("cy", 6, 7, 9)
    theirs = _settled(rival, "cooldown:cy")
    refused = [color for color, wait in ((9, mine), (5, theirs)) if wait > 0]
    accepted = [color for color, wait in ((9, mine), (5, theirs)) if wait == 0]
    shown = _pixel(ctx, m, 6, 7)
    assert shown not in refused or shown in accepted, f"two parallel tiles by cy on (6, 7): colour {accepted} was accepted, {refused} refused, and the board shows {shown} — the refused tile was painted. Claim the cooldown first, paint second"
    api = ctx.load("board_api")
    async with ctx.client(api.app) as c:
        r = await c.post("/place", json={"x": 3, "y": 7, "color": 5, "user": "ana"})
        assert r.status_code == 429, f"through the API a user on cooldown gets 429, got {r.status_code}"
        assert r.headers.get("retry-after") in ("299", "300"), f"Retry-After is {r.headers.get('retry-after')!r}, expected the TTL (300)"
        r = await c.post("/place", json={"x": 3, "y": 7, "color": 5, "user": "bo"})
        assert r.status_code == 200, f"another user may paint the same pixel: expected 200, got {r.status_code}"
    assert _pixel(ctx, api, 3, 7) == 5, "bo's tile must be painted"
`,
    typescript: `function board(ctx): Uint8Array {
  return ctx.redis.getBuffer('board') ?? new Uint8Array();
}

function pixel(ctx, m, x: number, y: number): number {
  const b = board(ctx);
  const off = y * m.SIZE + x;
  return off < b.length ? b[off] : 0;
}

function zeros(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) if (b === 0) n++;
  return n;
}

/** A parallel request that lands right after the first command on \`key\`: await it once it started, its own error re-thrown. */
function rival(ctx, key: string, fn: () => Promise<number>): (what: string) => Promise<number> {
  let started: Promise<number> | undefined;
  ctx.redisAfter(key, () => {
    started = fn();
  });
  return (what: string) => {
    assert(started !== undefined, \`placeTile never touched \${what}\`);
    return started;
  };
}

export async function check_cooldown_key(ctx) {
  const m = ctx.load('cooldown');
  assert.equal(await m.placeTile('ana', 3, 7, 12), 0, 'a user who never placed a tile is free: placeTile must return 0');
  assert.equal(ctx.redis.exists('cooldown:ana'), 1, \`after a placement the key cooldown:ana must exist (keys: \${JSON.stringify(ctx.redis.keys('*'))})\`);
  const ttl = ctx.redis.ttl('cooldown:ana');
  assert(295 <= ttl && ttl <= 300, \`cooldown:ana expires in \${ttl} s, expected COOLDOWN_S = 300\`);
  assert.equal(await m.placeTile('bo', 3, 8, 1), 0, "the cooldown is per user: bo is not affected by ana's tile");
  ctx.clock.advance(299);
  assert((await m.placeTile('ana', 4, 7, 1)) > 0, '299 s after her tile ana is still on cooldown: placeTile must refuse');
  ctx.clock.advance(2);
  assert.equal(ctx.redis.exists('cooldown:ana'), 0, 'cooldown:ana must be gone after 300 s');
  assert.equal(await m.placeTile('ana', 3, 7, 12), 0, 'once the key expired the user is free again');
}

export async function check_atomic_nx(ctx) {
  const m = ctx.load('cooldown');
  // A bot fires two requests at once; they reach two app servers. The second one runs right after
  // the first one's first command on cooldown:ana, the gap Reddit's check-then-write left open.
  const settled = rival(ctx, 'cooldown:ana', () => m.placeTile('ana', 4, 7, 5));
  const mine = await m.placeTile('ana', 3, 7, 12);
  const theirs = await settled('cooldown:ana');
  const painted = [mine === 0, theirs === 0];
  assert.equal(
    painted.filter(Boolean).length,
    1,
    \`two parallel placements by ana returned \${mine} and \${theirs}: \` +
      (painted[0] && painted[1]
        ? "both were painted. A check followed by a separate write lets every parallel request through — about 15 000 tiles slipped past r/place's cooldown that way; let one SET … NX decide"
        : 'neither was painted, but one of them must win'),
  );
  const [won, lost] = painted[0] ? [[3, 7, 12], [4, 7]] : [[4, 7, 5], [3, 7]];
  assert.equal(pixel(ctx, m, won[0], won[1]), won[2], \`the winning placement returned 0 but (\${won[0]}, \${won[1]}) shows \${pixel(ctx, m, won[0], won[1])}, expected \${won[2]}\`);
  assert.equal(pixel(ctx, m, lost[0], lost[1]), 0, \`the refused placement painted (\${lost[0]}, \${lost[1]}) anyway\`);
  const wait = await m.placeTile('ana', 5, 7, 1);
  assert(wait > 0, \`a later tile from the same user within 300 s must be refused, but placeTile returned \${wait}\`);
}

export async function check_paint(ctx) {
  const m = ctx.load('cooldown');
  const off = 7 * m.SIZE + 3;
  await m.placeTile('ana', 3, 7, 12);
  let b = board(ctx);
  assert(b.length > off, \`the board key is \${b.length} bytes after painting (3, 7): expected a write at offset y * SIZE + x = \${off}\`);
  assert.equal(b[off], 12, \`byte \${off} of the board is \${b[off]}, expected the colour 12\`);
  assert.equal(zeros(b), b.length - 1, 'painting one tile must change exactly one byte');
  await m.placeTile('bo', m.SIZE - 1, m.SIZE - 1, 15);
  b = board(ctx);
  assert.equal(b.length, m.SIZE * m.SIZE, \`after painting the last pixel the board is \${b.length} bytes, expected SIZE * SIZE = \${m.SIZE * m.SIZE}\`);
  assert.equal(b[b.length - 1], 15, \`the last byte is \${b[b.length - 1]}, expected 15\`);
  await m.placeTile('cy', 3, 7, 3);
  assert.equal(board(ctx)[off], 3, 'painting over a pixel replaces its colour');
  assert.equal(ctx.redis.type('board'), 'string', \`board is a \${ctx.redis.type('board')}, expected one string\`);
  // 200 placements a second: dee's tile is written while eve's is in progress.
  const settled = rival(ctx, 'board', () => m.placeTile('dee', 50, 50, 7));
  assert.equal(await m.placeTile('eve', 10, 10, 9), 0, 'eve is free: her tile must be painted');
  assert.equal(await settled('the board'), 0, 'dee is free: her tile must be painted');
  assert.equal(pixel(ctx, m, 10, 10), 9, \`eve's tile at (10, 10) is \${pixel(ctx, m, 10, 10)}, expected 9: dee's write, started while eve's was in progress, replaced the board with a copy read before eve painted. Write the one byte in place\`);
  assert.equal(pixel(ctx, m, 50, 50), 7, \`dee's tile at (50, 50), painted while eve's was being written, is \${pixel(ctx, m, 50, 50)} instead of 7: eve's write replaced the board with a copy read before dee painted. Write the one byte in place\`);
  assert(pixel(ctx, m, m.SIZE - 1, m.SIZE - 1) === 15 && pixel(ctx, m, 3, 7) === 3, 'earlier tiles must survive later ones');
}

export async function check_retry_after(ctx) {
  const m = ctx.load('cooldown');
  await m.placeTile('ana', 3, 7, 12);
  ctx.clock.advance(100);
  let wait = await m.placeTile('ana', 4, 7, 12);
  assert(199 <= wait && wait <= 200, \`100 s into a 300 s cooldown placeTile returned \${wait}, expected the TTL (200)\`);
  ctx.clock.advance(199.5);
  wait = await m.placeTile('ana', 4, 7, 12);
  assert.equal(wait, 1, \`half a second before the cooldown ends placeTile returned \${wait}, expected at least 1\`);
  ctx.clock.advance(1);
  assert.equal(await m.placeTile('ana', 4, 7, 12), 0, 'once the cooldown ended the tile must be painted');
}

export async function check_claim_first(ctx) {
  const m = ctx.load('cooldown');
  assert.equal(await m.placeTile('ana', 3, 7, 12), 0, 'ana is free: her tile must be painted');
  const wait = await m.placeTile('ana', 3, 7, 5);
  assert(wait > 0, 'the second tile within the cooldown must be refused');
  assert.equal(pixel(ctx, m, 3, 7), 12, \`a refused placement painted the board: (3, 7) is \${pixel(ctx, m, 3, 7)}, expected the earlier 12. Claim the cooldown first, paint second\`);
  // cy's two parallel requests on one pixel: the board must show the one that was accepted.
  const settled = rival(ctx, 'cooldown:cy', () => m.placeTile('cy', 6, 7, 5));
  const mine = await m.placeTile('cy', 6, 7, 9);
  const theirs = await settled('cooldown:cy');
  const outcomes: [number, number][] = [[9, mine], [5, theirs]];
  const refused = outcomes.filter(([, w]) => w > 0).map(([c]) => c);
  const accepted = outcomes.filter(([, w]) => w === 0).map(([c]) => c);
  const shown = pixel(ctx, m, 6, 7);
  assert(!refused.includes(shown) || accepted.includes(shown), \`two parallel tiles by cy on (6, 7): colour \${JSON.stringify(accepted)} was accepted, \${JSON.stringify(refused)} refused, and the board shows \${shown} — the refused tile was painted. Claim the cooldown first, paint second\`);
  const api = ctx.load('board_api');
  const c = ctx.client(api.app);
  let r = await c.post('/place', {json: {x: 3, y: 7, color: 5, user: 'ana'}});
  assert.equal(r.status, 429, \`through the API a user on cooldown gets 429, got \${r.status}\`);
  assert(['299', '300'].includes(r.headers['retry-after']), \`Retry-After is \${JSON.stringify(r.headers['retry-after'])}, expected the TTL (300)\`);
  r = await c.post('/place', {json: {x: 3, y: 7, color: 5, user: 'bo'}});
  assert.equal(r.status, 200, \`another user may paint the same pixel: expected 200, got \${r.status}\`);
  assert.equal(pixel(ctx, api, 3, 7), 5, "bo's tile must be painted");
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"leetbuild/harness"
)

var cdBg = context.Background()

func cdBoard(ctx *harness.Ctx) []byte {
	board, _ := ctx.Redis.Get("board")
	return []byte(board)
}

func cdPixel(ctx *harness.Ctx, x, y int) int {
	b := cdBoard(ctx)
	if off := y*size + x; off < len(b) {
		return int(b[off])
	}
	return 0
}

func cdZeros(b []byte) int {
	n := 0
	for _, c := range b {
		if c == 0 {
			n++
		}
	}
	return n
}

func cdPlace(ctx *harness.Ctx, user string, x, y, color int) int {
	wait, err := placeTile(cdBg, user, x, y, color)
	ctx.NoError(err, "placeTile(ctx, %q, %d, %d, %d) returned an error", user, x, y, color)
	return wait
}

// cdRival is a parallel request that runs right after the first command on key; the function it
// returns gives what that request's placeTile returned, its own error failing the check.
func cdRival(ctx *harness.Ctx, key, user string, x, y, color int) func(what string) int {
	var wait int
	var err error
	probe := ctx.Redis.After(key, func() any {
		wait, err = placeTile(cdBg, user, x, y, color)
		return nil
	})
	return func(what string) int {
		ctx.Assert(probe.Fired, "placeTile never touched %s", what)
		ctx.Assert(probe.Err == nil, "the parallel placeTile(ctx, %q, %d, %d, %d) failed: %v", user, x, y, color, probe.Err)
		ctx.NoError(err, "the parallel placeTile(ctx, %q, %d, %d, %d) returned an error", user, x, y, color)
		return wait
	}
}

// cdAPI is POST /place as step 1 deploys it, over this placeTile: 429 with Retry-After for a
// user on cooldown, 200 once the tile is painted.
func cdAPI(ctx *harness.Ctx) *harness.HTTP {
	return ctx.HTTP(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		var req struct {
			X     int    \`json:"x"\`
			Y     int    \`json:"y"\`
			Color int    \`json:"color"\`
			User  string \`json:"user"\`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			rw.WriteHeader(http.StatusBadRequest)
			return
		}
		wait, err := placeTile(r.Context(), req.User, req.X, req.Y, req.Color)
		switch {
		case err != nil:
			rw.WriteHeader(http.StatusServiceUnavailable)
		case wait > 0:
			rw.Header().Set("Retry-After", strconv.Itoa(wait))
			rw.WriteHeader(http.StatusTooManyRequests)
		default:
			rw.WriteHeader(http.StatusOK)
		}
	}))
}

func CheckCooldownKey(ctx *harness.Ctx) {
	ctx.Equal(cdPlace(ctx, "ana", 3, 7, 12), 0, "a user who never placed a tile is free: placeTile must return 0")
	ctx.Assert(ctx.Redis.Exists("cooldown:ana") == 1, "after a placement the key cooldown:ana must exist (keys: %s)", harness.Show(ctx.Redis.Keys("*")))
	ttl := ctx.Redis.TTL("cooldown:ana")
	ctx.Assert(295 <= ttl && ttl <= 300, "cooldown:ana expires in %d s, expected cooldown = 300 s", ttl)
	ctx.Equal(cdPlace(ctx, "bo", 3, 8, 1), 0, "the cooldown is per user: bo is not affected by ana's tile")
	ctx.Clock.Advance(299)
	ctx.Assert(cdPlace(ctx, "ana", 4, 7, 1) > 0, "299 s after her tile ana is still on cooldown: placeTile must refuse")
	ctx.Clock.Advance(2)
	ctx.Equal(ctx.Redis.Exists("cooldown:ana"), 0, "cooldown:ana must be gone after 300 s")
	ctx.Equal(cdPlace(ctx, "ana", 3, 7, 12), 0, "once the key expired the user is free again")
}

func CheckAtomicNx(ctx *harness.Ctx) {
	// A bot fires two requests at once; they reach two app servers. The second one runs right after
	// the first one's first command on cooldown:ana, the gap Reddit's check-then-write left open.
	settled := cdRival(ctx, "cooldown:ana", "ana", 4, 7, 5)
	mine := cdPlace(ctx, "ana", 3, 7, 12)
	theirs := settled("cooldown:ana")
	switch {
	case mine == 0 && theirs == 0:
		ctx.Fatalf("two parallel placements by ana returned %d and %d: both were painted. A check followed by a separate write lets every parallel request through (about 15 000 tiles slipped past r/place's cooldown that way); let one SET … NX decide", mine, theirs)
	case mine != 0 && theirs != 0:
		ctx.Fatalf("two parallel placements by ana returned %d and %d: neither was painted, but one of them must win", mine, theirs)
	}
	won, lost := [3]int{3, 7, 12}, [2]int{4, 7}
	if mine != 0 {
		won, lost = [3]int{4, 7, 5}, [2]int{3, 7}
	}
	ctx.Equal(cdPixel(ctx, won[0], won[1]), won[2], "the winning placement returned 0, so (%d, %d) must show its colour", won[0], won[1])
	ctx.Equal(cdPixel(ctx, lost[0], lost[1]), 0, "the refused placement painted (%d, %d) anyway", lost[0], lost[1])
	wait := cdPlace(ctx, "ana", 5, 7, 1)
	ctx.Assert(wait > 0, "a later tile from the same user within 300 s must be refused, but placeTile returned %d", wait)
}

func CheckPaint(ctx *harness.Ctx) {
	off := 7*size + 3
	cdPlace(ctx, "ana", 3, 7, 12)
	b := cdBoard(ctx)
	ctx.Assert(len(b) > off, "the board key is %d bytes after painting (3, 7): expected a write at offset y * size + x = %d", len(b), off)
	ctx.Equal(b[off], 12, "byte %d of the board must be the colour 12", off)
	ctx.Equal(cdZeros(b), len(b)-1, "painting one tile must change exactly one byte: the zero bytes")
	cdPlace(ctx, "bo", size-1, size-1, 15)
	b = cdBoard(ctx)
	ctx.Equal(len(b), size*size, "after painting the last pixel the board must be size * size bytes")
	ctx.Equal(b[len(b)-1], 15, "the last byte")
	cdPlace(ctx, "cy", 3, 7, 3)
	ctx.Equal(cdBoard(ctx)[off], 3, "painting over a pixel replaces its colour")
	ctx.Equal(ctx.Redis.Type("board"), "string", "board must be one string: its type")
	// 200 placements a second: dee's tile is written while eve's is in progress.
	settled := cdRival(ctx, "board", "dee", 50, 50, 7)
	ctx.Equal(cdPlace(ctx, "eve", 10, 10, 9), 0, "eve is free: her tile must be painted")
	ctx.Equal(settled("the board"), 0, "dee is free: her tile must be painted")
	ctx.Equal(cdPixel(ctx, 10, 10), 9, "eve's tile at (10, 10): dee's write, started while eve's was in progress, replaced the board with a copy read before eve painted. Write the one byte in place")
	ctx.Equal(cdPixel(ctx, 50, 50), 7, "dee's tile at (50, 50), painted while eve's was being written: eve's write replaced the board with a copy read before dee painted. Write the one byte in place")
	ctx.Assert(cdPixel(ctx, size-1, size-1) == 15 && cdPixel(ctx, 3, 7) == 3, "earlier tiles must survive later ones")
}

func CheckRetryAfter(ctx *harness.Ctx) {
	cdPlace(ctx, "ana", 3, 7, 12)
	ctx.Clock.Advance(100)
	wait := cdPlace(ctx, "ana", 4, 7, 12)
	ctx.Assert(199 <= wait && wait <= 200, "100 s into a 300 s cooldown placeTile returned %d, expected the TTL (200)", wait)
	ctx.Clock.Advance(199.5)
	wait = cdPlace(ctx, "ana", 4, 7, 12)
	ctx.Assert(wait == 1, "half a second before the cooldown ends placeTile returned %d, expected at least 1", wait)
	ctx.Clock.Advance(1)
	ctx.Equal(cdPlace(ctx, "ana", 4, 7, 12), 0, "once the cooldown ended the tile must be painted")
}

func CheckClaimFirst(ctx *harness.Ctx) {
	ctx.Equal(cdPlace(ctx, "ana", 3, 7, 12), 0, "ana is free: her tile must be painted")
	ctx.Assert(cdPlace(ctx, "ana", 3, 7, 5) > 0, "the second tile within the cooldown must be refused")
	ctx.Equal(cdPixel(ctx, 3, 7), 12, "a refused placement painted the board: (3, 7) must keep the earlier 12. Claim the cooldown first, paint second")
	// cy's two parallel requests on one pixel: the board must show the one that was accepted.
	settled := cdRival(ctx, "cooldown:cy", "cy", 6, 7, 5)
	mine := cdPlace(ctx, "cy", 6, 7, 9)
	theirs := settled("cooldown:cy")
	var accepted, refused []int
	for _, o := range [][2]int{{9, mine}, {5, theirs}} {
		if o[1] > 0 {
			refused = append(refused, o[0])
		} else if o[1] == 0 {
			accepted = append(accepted, o[0])
		}
	}
	shown := cdPixel(ctx, 6, 7)
	in := func(colors []int) bool {
		for _, c := range colors {
			if c == shown {
				return true
			}
		}
		return false
	}
	ctx.Assert(!in(refused) || in(accepted), "two parallel tiles by cy on (6, 7): colour %v was accepted, %v refused, and the board shows %d: the refused tile was painted. Claim the cooldown first, paint second", accepted, refused, shown)
	api := cdAPI(ctx)
	r := api.Post("/place", map[string]any{"x": 3, "y": 7, "color": 5, "user": "ana"})
	ctx.Equal(r.Status, 429, "through the API a user on cooldown gets 429")
	retry := r.Header.Get("Retry-After")
	ctx.Assert(retry == "299" || retry == "300", "Retry-After is %q, expected the TTL (300)", retry)
	r = api.Post("/place", map[string]any{"x": 3, "y": 7, "color": 5, "user": "bo"})
	ctx.Equal(r.Status, 200, "another user may paint the same pixel")
	ctx.Equal(cdPixel(ctx, 3, 7), 5, "bo's tile must be painted")
}
`,
  },
  debrief: `The cooldown and the lock are the same key. \`SET NX EX\` answers "was this user free?" and makes them not free in one atomic step, so a thousand parallel requests from one bot produce exactly one tile — the race Reddit shipped with (check in Cassandra, then write, with nothing in between) is simply not expressible here. \`SETRANGE\` is the other half of the design: the board is a flat array in a string, a pixel is one byte at a computed offset, and Redis updates it in place with no read, no lock and no version check, which is why 200 placements per second never contended. Real deployments pack two 4-bit pixels per byte with \`BITFIELD SET u4 #offset\`, keep the per-tile author and timestamp in a wide table for "who placed this?", and make the cooldown adjustable at runtime — Reddit turned the knob several times during the event to shed load.`,
};
