import type {Step} from '@/lib/types';

export const leaderboardStep: Step = {
  id: 'leaderboard',
  title: 'One sorted set: top, rank, neighbours, ties',
  concept: 'redis',
  file: 'leaderboard',
  focus: ['game', 'redis'],
  task: `## Task

Implement the module \`leaderboard\`: one sorted set \`board:{board}\` per board, member = player,
score = points. Points are integers; every function reports scores as integers. Ranks are
**1-based** and **descending by score** — rank 1 is the best. Nothing is sorted on the client:
every rank comes from Redis.

- \`add_points(board, player, points) -> int\`: \`ZINCRBY\` — a new player starts from 0; points may be
  negative; returns the player's new total.
- \`top(board, n) -> [(player, score, rank)]\`: the first \`n\` rows, best first, ranks \`1..n\`; fewer
  when the board is shorter, \`[]\` when it is empty. One \`ZREVRANGE … WITHSCORES\`, not one call per row.
- \`rank_of(board, player) -> (rank, score) | None\`: \`ZREVRANK\` + \`ZSCORE\`; \`None\` when the player is not
  on *that* board.
- \`around(board, player, k) -> [(player, score, rank)]\`: the \`k\` players above and the \`k\` below, the
  player included, in rank order with their **absolute** ranks. **Clip** the window at rank 1 and
  at the bottom — a window that would start above the top starts at rank 1 (watch out: \`ZREVRANGE\`
  reads a negative start as "from the end"). \`[]\` for a player not on the board; \`k = 0\` is the
  player alone.
- \`remove(board, player) -> bool\`: \`ZREM\`; whether the player was on the board. Everyone below moves
  up one rank.
- **Ties**: Redis orders equal scores by member, and in a descending view the lexicographically
  **greater** member comes first (\`zed\` ranks above \`mia\` at 50 points). Report that order — \`top\`,
  \`rank_of\` and \`around\` must agree on every player's rank.
- Boards are independent: a player's points on \`weekly\` say nothing about \`monthly\`.

> A sorted set is an order you can index into. \`ZREVRANK\` turns a member into a position, \`ZREVRANGE\`
> turns a position range into members; a leaderboard is the two glued together, with the window
> clipped before it goes negative.`,
  sequence: {
    participants: ['game server', 'Redis'],
    messages: [
      {from: 'game server', to: 'Redis', label: 'ZINCRBY board:weekly 15 ana', kind: 'sync'},
      {from: 'Redis', to: 'game server', label: '"55"', kind: 'reply'},
      {from: 'game server', to: 'Redis', label: 'ZREVRANGE board:weekly 0 2 WITHSCORES', kind: 'sync'},
      {from: 'Redis', to: 'game server', label: 'bo 75 · dee 60 · ana 55 → ranks 1, 2, 3', kind: 'reply'},
      {from: 'game server', to: 'Redis', label: 'ZREVRANK board:weekly ana', kind: 'sync'},
      {from: 'Redis', to: 'game server', label: '2 → rank 3', kind: 'reply'},
      {from: 'game server', to: 'Redis', label: 'ZREVRANGE board:weekly max(0, 2-5)=0 … 7 WITHSCORES', kind: 'sync'},
      {from: 'Redis', to: 'game server', label: 'the window, ranks 1…', kind: 'reply'},
    ],
  },
  hints: [
    'Rank = `ZREVRANK` + 1. Build `top` and `rank_of` first; `around` is `rank_of` followed by one `ZREVRANGE` over `[index - k, index + k]`, with every row numbered `start + i + 1`.',
    '`ZREVRANGE key -2 5` does not mean "from rank -2": negative indices count from the end. Clamp the start with `max(0, index - k)` before you ask; a stop past the end is fine.',
    'Do not re-sort rows on the client to "fix" ties — Redis already ordered them (equal scores: greater member first in a descending range) and `ZREVRANK` reports exactly that position. Trust it and the three functions agree.',
  ],
  checks: [
    {
      id: 'top-order',
      title: 'top lists the best first with 1-based ranks',
      detail:
        '`top(board, n)` returns the `n` highest scorers as `(player, score, rank)` with ranks `1..n`, fewer rows when the board is shorter, `[]` when it is empty — from one `ZREVRANGE … WITHSCORES`.',
      match: {
        python: {all: [/\.zrevrange\(/, /withscores=True/]},
        typescript: {all: [/\.zrevrange\(/, /'WITHSCORES'/]},
        go: {all: [/\.ZRevRangeWithScores\(/]},
        scala: {all: [/\.zrevrangeWithScores\(/]},
        cpp: {all: [/\.zrevrange\(/, /std::back_inserter\(/]},
      },
    },
    {
      id: 'rank-of',
      title: 'rank_of reports the rank and score top shows',
      detail:
        'For every row of `top`, `rank_of(board, player)` is `(rank, score)` from `ZREVRANK` and `ZSCORE`; a player not on that board — even one on another board — answers `None`.',
      match: {
        python: {all: [/\.zrevrank\(/, /\.zscore\(/]},
        typescript: {all: [/\.zrevrank\(/, /\.zscore\(/]},
        go: {all: [/\.ZRevRank\(/, /\.ZScore\(/]},
        scala: {all: [/\.zrevrank\(/, /\.zscore\(/]},
        cpp: {all: [/\.zrevrank\(/, /\.zscore\(/]},
      },
    },
    {
      id: 'around-clips',
      title: 'around clips at both ends and keeps absolute ranks',
      detail:
        '`around(board, player, k)` is the `k` above, the player, the `k` below, numbered with their real ranks; near rank 1 the window starts at 1 (a negative `ZREVRANGE` start would read from the end), near the bottom it stops at the last player; `k = 0` is the player alone, a stranger gets `[]`.',
      match: {
        python: {all: [/max\(0, index - k\)/, /index \+ k/]},
        typescript: {all: [/Math\.max\(0, index - k\)/, /index \+ k/]},
        go: {all: [/max\(0, index-k64\)/, /index\+k64/]},
        scala: {all: [/math\.max\(0, index - k\)/, /index \+ k/]},
        cpp: {all: [/std::max\(0LL, index - k\)/, /index \+ k/]},
      },
    },
    {
      id: 'ties',
      title: 'Ties rank the same in top, rank_of and around',
      detail:
        'Equal scores are ordered by Redis (greater member first in the descending view); the three functions report that order, so every player has one rank — no client-side sort may reshuffle the rows.',
      match: {
        python: {all: [/\.zrevrank\(/], none: [/sorted\(|\.sort\(/]},
        typescript: {all: [/\.zrevrank\(/], none: [/\.sort\(/]},
        go: {all: [/\.ZRevRank\(/], none: [/sort\./]},
        scala: {all: [/\.zrevrank\(/], none: [/\.sort(By|With)?\(/]},
        cpp: {all: [/\.zrevrank\(/], none: [/std::sort\(/]},
      },
    },
    {
      id: 'accumulate',
      title: 'add_points accumulates in board:{board}',
      detail:
        '`add_points` is `ZINCRBY` on `board:{board}`: 10 then 5 is 15, then −3 is 12, each call returning the new total; a new player starts from 0; the same player on two boards has two independent scores. `ZADD` would overwrite.',
      match: {
        python: {all: [/\.zincrby\(/, /f"board:\{board\}"/], none: [/\.zadd\(/]},
        typescript: {all: [/\.zincrby\(/, /`board:\$\{board\}`/], none: [/\.zadd\(/]},
        go: {all: [/\.ZIncrBy\(/, /"board:" \+ board/], none: [/\.ZAdd\(/]},
        scala: {all: [/\.zincrby\(/, /s"board:\$board"/], none: [/\.zadd\(/]},
        cpp: {all: [/\.zincrby\(/, /"board:" \+ board/], none: [/\.zadd\(/]},
      },
    },
    {
      id: 'remove',
      title: 'remove drops the player and closes the gap',
      detail:
        '`remove(board, player)` is `ZREM`: it returns whether the player was there, `rank_of` answers `None` afterwards, everyone below moves up one rank, and other boards are untouched.',
      match: {
        python: {all: [/\.zrem\(/]},
        typescript: {all: [/\.zrem\(/]},
        go: {all: [/\.ZRem\(/]},
        scala: {all: [/\.zrem\(/]},
        cpp: {all: [/\.zrem\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""One sorted set per board: ranks, neighbours and ties come from Redis, never from a client-side sort."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def board_key(board: str) -> str:
    return f"board:{board}"


def add_points(board: str, player: str, points: int) -> int:
    """ZINCRBY: the player's new total; a new player starts from 0."""
    # TODO
    raise NotImplementedError


def top(board: str, n: int) -> list[tuple[str, int, int]]:
    """The first n rows, best first: (player, score, rank), rank 1-based. One ZREVRANGE WITHSCORES."""
    # TODO
    raise NotImplementedError


def rank_of(board: str, player: str) -> tuple[int, int] | None:
    """(rank, score) as Redis ranks the player, or None when the player is not on the board."""
    # TODO: ZREVRANK + 1, ZSCORE
    raise NotImplementedError


def around(board: str, player: str, k: int) -> list[tuple[str, int, int]]:
    """The k players above and the k below, clipped at the ends, with their absolute ranks; [] for a stranger."""
    # TODO: ZREVRANK, clamp the start at 0, one ZREVRANGE, number the rows from start + 1
    raise NotImplementedError


def remove(board: str, player: str) -> bool:
    """ZREM: whether the player was on the board; everyone below moves up one rank."""
    # TODO
    raise NotImplementedError
`,
      solution: `"""One sorted set per board: ranks, neighbours and ties come from Redis, never from a client-side sort."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def board_key(board: str) -> str:
    return f"board:{board}"


def add_points(board: str, player: str, points: int) -> int:
    """ZINCRBY: the player's new total; a new player starts from 0."""
    return int(r.zincrby(board_key(board), points, player))


def top(board: str, n: int) -> list[tuple[str, int, int]]:
    """The first n rows, best first: (player, score, rank), rank 1-based. One ZREVRANGE WITHSCORES."""
    rows = r.zrevrange(board_key(board), 0, n - 1, withscores=True)
    return [(player, int(score), i + 1) for i, (player, score) in enumerate(rows)]


def rank_of(board: str, player: str) -> tuple[int, int] | None:
    """(rank, score) as Redis ranks the player, or None when the player is not on the board."""
    key = board_key(board)
    index = r.zrevrank(key, player)
    if index is None:
        return None
    return index + 1, int(r.zscore(key, player))


def around(board: str, player: str, k: int) -> list[tuple[str, int, int]]:
    """The k players above and the k below, clipped at the ends, with their absolute ranks; [] for a stranger."""
    key = board_key(board)
    index = r.zrevrank(key, player)
    if index is None:
        return []
    start = max(0, index - k)
    rows = r.zrevrange(key, start, index + k, withscores=True)
    return [(member, int(score), start + i + 1) for i, (member, score) in enumerate(rows)]


def remove(board: str, player: str) -> bool:
    """ZREM: whether the player was on the board; everyone below moves up one rank."""
    return r.zrem(board_key(board), player) == 1
`,
    },
    typescript: {
      starter: `/** One sorted set per board: ranks, neighbours and ties come from Redis, never from a client-side sort. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** One leaderboard line; rank is 1-based, best first. */
export interface Row {
  player: string;
  score: number;
  rank: number;
}

export interface Standing {
  rank: number;
  score: number;
}

export const boardKey = (board: string): string => \`board:\${board}\`;

/** ZINCRBY: the player's new total; a new player starts from 0. */
export async function addPoints(board: string, player: string, points: number): Promise<number> {
  // TODO
  throw new Error('not implemented');
}

/** The first n rows, best first, rank 1-based. One ZREVRANGE WITHSCORES. */
export async function top(board: string, n: number): Promise<Row[]> {
  // TODO
  throw new Error('not implemented');
}

/** {rank, score} as Redis ranks the player, or null when the player is not on the board. */
export async function rankOf(board: string, player: string): Promise<Standing | null> {
  // TODO: ZREVRANK + 1, ZSCORE
  throw new Error('not implemented');
}

/** The k players above and the k below, clipped at the ends, with their absolute ranks; [] for a stranger. */
export async function around(board: string, player: string, k: number): Promise<Row[]> {
  // TODO: ZREVRANK, clamp the start at 0, one ZREVRANGE, number the rows from start + 1
  throw new Error('not implemented');
}

/** ZREM: whether the player was on the board; everyone below moves up one rank. */
export async function remove(board: string, player: string): Promise<boolean> {
  // TODO
  throw new Error('not implemented');
}
`,
      solution: `/** One sorted set per board: ranks, neighbours and ties come from Redis, never from a client-side sort. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** One leaderboard line; rank is 1-based, best first. */
export interface Row {
  player: string;
  score: number;
  rank: number;
}

export interface Standing {
  rank: number;
  score: number;
}

export const boardKey = (board: string): string => \`board:\${board}\`;

/** A WITHSCORES reply (member, score, member, score…) as rows numbered from firstRank. */
const rows = (flat: string[], firstRank: number): Row[] => {
  const out: Row[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push({player: flat[i], score: Number(flat[i + 1]), rank: firstRank + i / 2});
  }
  return out;
};

/** ZINCRBY: the player's new total; a new player starts from 0. */
export async function addPoints(board: string, player: string, points: number): Promise<number> {
  return Number(await redis.zincrby(boardKey(board), points, player));
}

/** The first n rows, best first, rank 1-based. One ZREVRANGE WITHSCORES. */
export async function top(board: string, n: number): Promise<Row[]> {
  return rows(await redis.zrevrange(boardKey(board), 0, n - 1, 'WITHSCORES'), 1);
}

/** {rank, score} as Redis ranks the player, or null when the player is not on the board. */
export async function rankOf(board: string, player: string): Promise<Standing | null> {
  const key = boardKey(board);
  const index = await redis.zrevrank(key, player);
  if (index === null) return null;
  return {rank: index + 1, score: Number(await redis.zscore(key, player))};
}

/** The k players above and the k below, clipped at the ends, with their absolute ranks; [] for a stranger. */
export async function around(board: string, player: string, k: number): Promise<Row[]> {
  const key = boardKey(board);
  const index = await redis.zrevrank(key, player);
  if (index === null) return [];
  const start = Math.max(0, index - k);
  return rows(await redis.zrevrange(key, start, index + k, 'WITHSCORES'), start + 1);
}

/** ZREM: whether the player was on the board; everyone below moves up one rank. */
export async function remove(board: string, player: string): Promise<boolean> {
  return (await redis.zrem(boardKey(board), player)) === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is one leaderboard line; Rank is 1-based, best first.
type Row struct {
	Player string
	Score  int
	Rank   int
}

// Standing is where one player sits.
type Standing struct {
	Rank  int
	Score int
}

func boardKey(board string) string { return "board:" + board }

// addPoints is ZINCRBY: the player's new total; a new player starts from 0.
func addPoints(ctx context.Context, board, player string, points int) (int, error) {
	// TODO
	panic("not implemented")
}

// top returns the first n rows, best first, rank 1-based. One ZREVRANGE WITHSCORES.
func top(ctx context.Context, board string, n int) ([]Row, error) {
	// TODO
	panic("not implemented")
}

// rankOf returns the standing as Redis ranks the player, or nil when the player is not on the board.
func rankOf(ctx context.Context, board, player string) (*Standing, error) {
	// TODO: ZREVRANK + 1, ZSCORE
	panic("not implemented")
}

// around returns the k players above and the k below, clipped at the ends, with their absolute ranks; empty for a stranger.
func around(ctx context.Context, board, player string, k int) ([]Row, error) {
	// TODO: ZREVRANK, clamp the start at 0, one ZREVRANGE, number the rows from start + 1
	panic("not implemented")
}

// remove is ZREM: whether the player was on the board; everyone below moves up one rank.
func remove(ctx context.Context, board, player string) (bool, error) {
	// TODO
	panic("not implemented")
}

func main() {
	ctx := context.Background()
	if _, err := addPoints(ctx, "weekly", "ana", 10); err != nil {
		panic(err)
	}
	rows, err := top(ctx, "weekly", 10)
	if err != nil {
		panic(err)
	}
	fmt.Println(rows)
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is one leaderboard line; Rank is 1-based, best first.
type Row struct {
	Player string
	Score  int
	Rank   int
}

// Standing is where one player sits.
type Standing struct {
	Rank  int
	Score int
}

func boardKey(board string) string { return "board:" + board }

// rows numbers a WITHSCORES reply from firstRank.
func rows(zs []redis.Z, firstRank int) []Row {
	out := make([]Row, 0, len(zs))
	for i, z := range zs {
		out = append(out, Row{Player: z.Member.(string), Score: int(z.Score), Rank: firstRank + i})
	}
	return out
}

// addPoints is ZINCRBY: the player's new total; a new player starts from 0.
func addPoints(ctx context.Context, board, player string, points int) (int, error) {
	total, err := rdb.ZIncrBy(ctx, boardKey(board), float64(points), player).Result()
	if err != nil {
		return 0, err
	}
	return int(total), nil
}

// top returns the first n rows, best first, rank 1-based. One ZREVRANGE WITHSCORES.
func top(ctx context.Context, board string, n int) ([]Row, error) {
	zs, err := rdb.ZRevRangeWithScores(ctx, boardKey(board), 0, int64(n-1)).Result()
	if err != nil {
		return nil, err
	}
	return rows(zs, 1), nil
}

// rankOf returns the standing as Redis ranks the player, or nil when the player is not on the board.
func rankOf(ctx context.Context, board, player string) (*Standing, error) {
	key := boardKey(board)
	index, err := rdb.ZRevRank(ctx, key, player).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	score, err := rdb.ZScore(ctx, key, player).Result()
	if err != nil {
		return nil, err
	}
	return &Standing{Rank: int(index) + 1, Score: int(score)}, nil
}

// around returns the k players above and the k below, clipped at the ends, with their absolute ranks; empty for a stranger.
func around(ctx context.Context, board, player string, k int) ([]Row, error) {
	key := boardKey(board)
	index, err := rdb.ZRevRank(ctx, key, player).Result()
	if errors.Is(err, redis.Nil) {
		return []Row{}, nil
	}
	if err != nil {
		return nil, err
	}
	k64 := int64(k)
	start := max(0, index-k64)
	zs, err := rdb.ZRevRangeWithScores(ctx, key, start, index+k64).Result()
	if err != nil {
		return nil, err
	}
	return rows(zs, int(start)+1), nil
}

// remove is ZREM: whether the player was on the board; everyone below moves up one rank.
func remove(ctx context.Context, board, player string) (bool, error) {
	removed, err := rdb.ZRem(ctx, boardKey(board), player).Result()
	if err != nil {
		return false, err
	}
	return removed == 1, nil
}

func main() {
	ctx := context.Background()
	if _, err := addPoints(ctx, "weekly", "ana", 10); err != nil {
		panic(err)
	}
	rows, err := top(ctx, "weekly", 10)
	if err != nil {
		panic(err)
	}
	fmt.Println(rows)
}
`,
    },
    scala: {
      starter: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.resps.Tuple

/** One sorted set per board: ranks, neighbours and ties come from Redis, never from a client-side sort. */
object Leaderboard {
  val jedis = new JedisPooled("redis", 6379)

  /** One leaderboard line; rank is 1-based, best first. */
  case class Row(player: String, score: Int, rank: Int)
  case class Standing(rank: Int, score: Int)

  def boardKey(board: String): String = s"board:$board"

  /** ZINCRBY: the player's new total; a new player starts from 0. */
  def addPoints(board: String, player: String, points: Int): Int = {
    ??? // TODO
  }

  /** The first n rows, best first, rank 1-based. One ZREVRANGE WITHSCORES. */
  def top(board: String, n: Int): List[Row] = {
    ??? // TODO
  }

  /** Standing(rank, score) as Redis ranks the player, or None when the player is not on the board. */
  def rankOf(board: String, player: String): Option[Standing] = {
    ??? // TODO: ZREVRANK + 1, ZSCORE
  }

  /** The k players above and the k below, clipped at the ends, with their absolute ranks; Nil for a stranger. */
  def around(board: String, player: String, k: Int): List[Row] = {
    ??? // TODO: ZREVRANK, clamp the start at 0, one ZREVRANGE, number the rows from start + 1
  }

  /** ZREM: whether the player was on the board; everyone below moves up one rank. */
  def remove(board: String, player: String): Boolean = {
    ??? // TODO
  }

  def main(args: Array[String]): Unit = {
    addPoints("weekly", "ana", 10)
    println(top("weekly", 10))
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.resps.Tuple

/** One sorted set per board: ranks, neighbours and ties come from Redis, never from a client-side sort. */
object Leaderboard {
  val jedis = new JedisPooled("redis", 6379)

  /** One leaderboard line; rank is 1-based, best first. */
  case class Row(player: String, score: Int, rank: Int)
  case class Standing(rank: Int, score: Int)

  def boardKey(board: String): String = s"board:$board"

  /** A WITHSCORES reply as rows numbered from firstRank. */
  private def rows(tuples: java.util.List[Tuple], firstRank: Int): List[Row] =
    tuples.asScala.toList.zipWithIndex.map { case (t, i) => Row(t.getElement, t.getScore.toInt, firstRank + i) }

  /** ZINCRBY: the player's new total; a new player starts from 0. */
  def addPoints(board: String, player: String, points: Int): Int =
    jedis.zincrby(boardKey(board), points.toDouble, player).toInt

  /** The first n rows, best first, rank 1-based. One ZREVRANGE WITHSCORES. */
  def top(board: String, n: Int): List[Row] =
    rows(jedis.zrevrangeWithScores(boardKey(board), 0, n - 1), 1)

  /** Standing(rank, score) as Redis ranks the player, or None when the player is not on the board. */
  def rankOf(board: String, player: String): Option[Standing] = {
    val key = boardKey(board)
    Option(jedis.zrevrank(key, player)).map(index => Standing(index.toInt + 1, jedis.zscore(key, player).toInt))
  }

  /** The k players above and the k below, clipped at the ends, with their absolute ranks; Nil for a stranger. */
  def around(board: String, player: String, k: Int): List[Row] = {
    val key = boardKey(board)
    Option(jedis.zrevrank(key, player)) match {
      case None => Nil
      case Some(found) =>
        val index = found.toInt
        val start = math.max(0, index - k)
        rows(jedis.zrevrangeWithScores(key, start, index + k), start + 1)
    }
  }

  /** ZREM: whether the player was on the board; everyone below moves up one rank. */
  def remove(board: String, player: String): Boolean =
    jedis.zrem(boardKey(board), player) == 1

  def main(args: Array[String]): Unit = {
    addPoints("weekly", "ana", 10)
    println(top("weekly", 10))
  }
}
`,
    },
    cpp: {
      starter: `// One sorted set per board: ranks, neighbours and ties come from Redis, never from a client-side sort.
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iostream>
#include <iterator>
#include <optional>
#include <string>
#include <utility>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// One leaderboard line; rank is 1-based, best first.
struct Row {
  std::string player;
  long long score;
  long long rank;
};

struct Standing {
  long long rank;
  long long score;
};

std::string board_key(const std::string& board) { return "board:" + board; }

// ZINCRBY: the player's new total; a new player starts from 0.
long long add_points(const std::string& board, const std::string& player, long long points) {
  // TODO
  throw std::logic_error("not implemented");
}

// The first n rows, best first, rank 1-based. One ZREVRANGE WITHSCORES.
std::vector<Row> top(const std::string& board, long long n) {
  // TODO
  throw std::logic_error("not implemented");
}

// {rank, score} as Redis ranks the player, or nullopt when the player is not on the board.
std::optional<Standing> rank_of(const std::string& board, const std::string& player) {
  // TODO: ZREVRANK + 1, ZSCORE
  throw std::logic_error("not implemented");
}

// The k players above and the k below, clipped at the ends, with their absolute ranks; empty for a stranger.
std::vector<Row> around(const std::string& board, const std::string& player, long long k) {
  // TODO: ZREVRANK, clamp the start at 0, one ZREVRANGE, number the rows from start + 1
  throw std::logic_error("not implemented");
}

// ZREM: whether the player was on the board; everyone below moves up one rank.
bool remove_player(const std::string& board, const std::string& player) {
  // TODO
  throw std::logic_error("not implemented");
}

int main() {
  add_points("weekly", "ana", 10);
  for (const auto& row : top("weekly", 10)) std::cout << row.rank << ". " << row.player << " " << row.score << "\\n";
}
`,
      solution: `// One sorted set per board: ranks, neighbours and ties come from Redis, never from a client-side sort.
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iostream>
#include <iterator>
#include <optional>
#include <string>
#include <utility>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// One leaderboard line; rank is 1-based, best first.
struct Row {
  std::string player;
  long long score;
  long long rank;
};

struct Standing {
  long long rank;
  long long score;
};

std::string board_key(const std::string& board) { return "board:" + board; }

// A WITHSCORES reply as rows numbered from first_rank.
std::vector<Row> rows(const std::vector<std::pair<std::string, double>>& scored, long long first_rank) {
  std::vector<Row> out;
  out.reserve(scored.size());
  for (std::size_t i = 0; i < scored.size(); ++i) {
    out.push_back({scored[i].first, static_cast<long long>(scored[i].second), first_rank + static_cast<long long>(i)});
  }
  return out;
}

// ZINCRBY: the player's new total; a new player starts from 0.
long long add_points(const std::string& board, const std::string& player, long long points) {
  return static_cast<long long>(redis.zincrby(board_key(board), static_cast<double>(points), player));
}

// The first n rows, best first, rank 1-based. One ZREVRANGE WITHSCORES.
std::vector<Row> top(const std::string& board, long long n) {
  std::vector<std::pair<std::string, double>> scored;
  redis.zrevrange(board_key(board), 0, n - 1, std::back_inserter(scored));
  return rows(scored, 1);
}

// {rank, score} as Redis ranks the player, or nullopt when the player is not on the board.
std::optional<Standing> rank_of(const std::string& board, const std::string& player) {
  const std::string key = board_key(board);
  const auto index = redis.zrevrank(key, player);
  if (!index) return std::nullopt;
  const auto score = redis.zscore(key, player);
  return Standing{*index + 1, static_cast<long long>(*score)};
}

// The k players above and the k below, clipped at the ends, with their absolute ranks; empty for a stranger.
std::vector<Row> around(const std::string& board, const std::string& player, long long k) {
  const std::string key = board_key(board);
  const auto found = redis.zrevrank(key, player);
  if (!found) return {};
  const long long index = *found;
  const long long start = std::max(0LL, index - k);
  std::vector<std::pair<std::string, double>> scored;
  redis.zrevrange(key, start, index + k, std::back_inserter(scored));
  return rows(scored, start + 1);
}

// ZREM: whether the player was on the board; everyone below moves up one rank.
bool remove_player(const std::string& board, const std::string& player) {
  return redis.zrem(board_key(board), player) == 1;
}

int main() {
  add_points("weekly", "ana", 10);
  for (const auto& row : top("weekly", 10)) std::cout << row.rank << ". " << row.player << " " << row.score << "\\n";
}
`,
    },
  },
  harness: {
    python: `def seed(m, board, scores):
    for player, points in scores:
        m.add_points(board, player, points)


FIVE = [("ana", 40), ("bo", 75), ("cy", 10), ("dee", 60), ("eli", 25)]
SEVEN = [("ana", 70), ("bo", 60), ("cy", 50), ("dee", 40), ("eli", 30), ("fay", 20), ("gus", 10)]


def expected_order(scores):
    """The spec, independent of the learner: score descending, then member descending (Redis's ZREVRANGE rule)."""
    ordered = sorted(scores, key=lambda row: (row[1], row[0]), reverse=True)
    return [(player, score, i + 1) for i, (player, score) in enumerate(ordered)]


def counting(ctx):
    """Every command any client in the runtime sends, by name — the learner's clients share ctx.redis's class."""
    calls = []
    cls = ctx.redis.__class__
    real = cls.execute_command

    def record(self, *args, **kw):
        calls.append(str(args[0]).upper())
        return real(self, *args, **kw)

    cls.execute_command = record
    return calls, lambda: setattr(cls, "execute_command", real)


def check_top_order(ctx):
    m = ctx.load("leaderboard")
    assert m.top("weekly", 3) == [], f"an empty board has no rows; top returned {m.top('weekly', 3)!r}"
    seed(m, "weekly", FIVE)
    assert m.top("weekly", 3) == [("bo", 75, 1), ("dee", 60, 2), ("ana", 40, 3)], f"top('weekly', 3) must be the three highest scorers, best first, as (player, score, rank) with ranks 1, 2, 3; got {m.top('weekly', 3)!r}"
    assert m.top("weekly", 1) == [("bo", 75, 1)], f"top('weekly', 1) is the leader alone; got {m.top('weekly', 1)!r}"
    assert m.top("weekly", 10) == expected_order(FIVE), f"n larger than the board returns everyone, still ranked 1..5; got {m.top('weekly', 10)!r}"
    calls, restore = counting(ctx)
    try:
        m.top("weekly", 3)
    finally:
        restore()
    assert calls == ["ZREVRANGE"], f"top is one ZREVRANGE … WITHSCORES (members and scores in one reply); it sent {calls}"


def check_rank_of(ctx):
    m = ctx.load("leaderboard")
    seed(m, "weekly", FIVE)
    seed(m, "monthly", [("bo", 5), ("zed", 90)])
    for player, score, rank in m.top("weekly", 5):
        got = m.rank_of("weekly", player)
        assert got == (rank, score), f"top shows {player} at rank {rank} with {score} points, but rank_of('weekly', {player!r}) says {got!r}: rank = ZREVRANK + 1, score = ZSCORE"
    assert m.rank_of("weekly", "ghost") is None, "a player who never scored on the board has no rank: None, not an error and not (0, 0)"
    assert m.rank_of("monthly", "ana") is None, "boards are independent: ana is on weekly, not on monthly"
    assert m.rank_of("monthly", "bo") == (2, 5), f"bo leads weekly but is second on monthly with 5 points; rank_of('monthly', 'bo') says {m.rank_of('monthly', 'bo')!r}"


def check_around_clips(ctx):
    m = ctx.load("leaderboard")
    seed(m, "weekly", SEVEN)
    rows = expected_order(SEVEN)
    assert m.around("weekly", "dee", 2) == rows[1:6], f"around('weekly', 'dee', 2) is bo…fay with ranks 2..6 (two above, dee, two below); got {m.around('weekly', 'dee', 2)!r}"
    assert m.around("weekly", "ana", 2) == rows[0:3], f"the leader has nobody above: around('weekly', 'ana', 2) must clip to ranks 1..3, not read a negative start from the end of the set; got {m.around('weekly', 'ana', 2)!r}"
    assert m.around("weekly", "bo", 2) == rows[0:4], f"around('weekly', 'bo', 2): one above (ana, rank 1), bo, two below; got {m.around('weekly', 'bo', 2)!r}"
    assert m.around("weekly", "gus", 2) == rows[4:7], f"the last player has nobody below: around('weekly', 'gus', 2) is ranks 5..7; got {m.around('weekly', 'gus', 2)!r}"
    assert m.around("weekly", "fay", 3) == rows[2:7], f"around('weekly', 'fay', 3) clips at the bottom: ranks 3..7; got {m.around('weekly', 'fay', 3)!r}"
    assert m.around("weekly", "dee", 0) == [rows[3]], f"k = 0 is the player alone with the absolute rank 4; got {m.around('weekly', 'dee', 0)!r}"
    assert m.around("weekly", "dee", 100) == rows, f"a window wider than the board is the whole board, ranks 1..7; got {m.around('weekly', 'dee', 100)!r}"
    assert m.around("weekly", "zed", 2) == [], f"a player not on the board has no neighbours: []; got {m.around('weekly', 'zed', 2)!r}"


def check_ties(ctx):
    m = ctx.load("leaderboard")
    tied = [("mia", 50), ("zed", 50), ("abe", 50), ("kim", 80), ("lou", 20), ("bea", 20)]
    seed(m, "weekly", tied)
    rows = expected_order(tied)
    assert m.top("weekly", 6) == rows, f"equal scores are ordered by Redis: in the descending view the greater member comes first (zed, mia, abe at 50; lou before bea at 20); top returned {m.top('weekly', 6)!r}"
    for player, score, rank in rows:
        assert m.rank_of("weekly", player) == (rank, score), f"rank_of('weekly', {player!r}) must agree with top: ({rank}, {score}), got {m.rank_of('weekly', player)!r}"
    assert m.around("weekly", "mia", 1) == rows[1:4], f"around('weekly', 'mia', 1) is zed (2), mia (3), abe (4) — the same tie order as top; got {m.around('weekly', 'mia', 1)!r}"
    assert m.around("weekly", "abe", 1) == rows[2:5], f"around('weekly', 'abe', 1) is mia (3), abe (4), lou (5); got {m.around('weekly', 'abe', 1)!r}"
    m.add_points("weekly", "abe", 1)
    assert m.rank_of("weekly", "abe") == (2, 51), f"one more point breaks the tie: abe moves to rank 2 with 51; rank_of says {m.rank_of('weekly', 'abe')!r}"
    assert m.top("weekly", 3) == [("kim", 80, 1), ("abe", 51, 2), ("zed", 50, 3)], f"after abe's point top is kim, abe, zed; got {m.top('weekly', 3)!r}"


def check_accumulate(ctx):
    m = ctx.load("leaderboard")
    assert m.add_points("weekly", "ana", 10) == 10, "a new player starts from 0: the first add_points returns the points given"
    assert m.add_points("weekly", "ana", 5) == 15, "add_points accumulates (ZINCRBY): 10 then 5 is 15, not 5 — ZADD would overwrite"
    assert m.add_points("weekly", "ana", -3) == 12, "negative points subtract: 15 − 3 is 12"
    assert m.add_points("weekly", "bo", 5) == 5, "another player's first score is just their points"
    assert ctx.redis.zscore("board:weekly", "ana") == 12, f"the board lives in the sorted set board:weekly with the player as member and the total as score; keys: {ctx.redis.keys('*')}, ana's score there: {ctx.redis.zscore('board:weekly', 'ana')!r}"
    assert sorted(ctx.redis.keys("*")) == ["board:weekly"], f"one key per board, named board:{{board}}; the keys are {sorted(ctx.redis.keys('*'))}"
    assert m.add_points("monthly", "ana", 100) == 100, "the same player on another board starts from 0 there"
    assert m.rank_of("weekly", "ana") == (1, 12), f"monthly points must not touch weekly: ana still leads weekly with 12; rank_of says {m.rank_of('weekly', 'ana')!r}"
    assert m.rank_of("monthly", "ana") == (1, 100)
    assert m.top("weekly", 5) == [("ana", 12, 1), ("bo", 5, 2)], f"top reflects the accumulated totals; got {m.top('weekly', 5)!r}"


def check_remove(ctx):
    m = ctx.load("leaderboard")
    seed(m, "weekly", FIVE)
    seed(m, "monthly", [("bo", 5)])
    assert m.remove("weekly", "bo") is True, "removing a player who is on the board returns True"
    assert m.rank_of("weekly", "bo") is None, "after remove the player has no rank on that board"
    assert m.top("weekly", 5) == [("dee", 60, 1), ("ana", 40, 2), ("eli", 25, 3), ("cy", 10, 4)], f"with the leader gone everyone moves up one rank; top returned {m.top('weekly', 5)!r}"
    assert m.around("weekly", "ana", 1) == [("dee", 60, 1), ("ana", 40, 2), ("eli", 25, 3)], f"around reflects the new ranks too; got {m.around('weekly', 'ana', 1)!r}"
    assert m.remove("weekly", "bo") is False, "removing a player a second time returns False: there was nothing to remove"
    assert m.remove("weekly", "ghost") is False, "removing a player who never scored returns False"
    assert m.rank_of("monthly", "bo") == (1, 5), f"remove touches one board only: bo is still on monthly; rank_of says {m.rank_of('monthly', 'bo')!r}"
    assert m.add_points("weekly", "bo", 1) == 1, "a removed player who scores again starts from 0"
`,
    typescript: `type Row = {player: string; score: number; rank: number};

const FIVE: [string, number][] = [['ana', 40], ['bo', 75], ['cy', 10], ['dee', 60], ['eli', 25]];
const SEVEN: [string, number][] = [['ana', 70], ['bo', 60], ['cy', 50], ['dee', 40], ['eli', 30], ['fay', 20], ['gus', 10]];

async function seed(m, board: string, scores: [string, number][]) {
  for (const [player, points] of scores) await m.addPoints(board, player, points);
}

/** The spec, independent of the learner: score descending, then member descending (Redis's ZREVRANGE rule). */
function expectedOrder(scores: [string, number][]): Row[] {
  const ordered = [...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  return ordered.map(([player, score], i) => ({player, score, rank: i + 1}));
}

const show = (v: unknown) => JSON.stringify(v);

export async function check_top_order(ctx) {
  const m = ctx.load('leaderboard');
  assert.deepEqual(await m.top('weekly', 3), [], \`an empty board has no rows; top returned \${show(await m.top('weekly', 3))}\`);
  await seed(m, 'weekly', FIVE);
  assert.deepEqual(await m.top('weekly', 3), [{player: 'bo', score: 75, rank: 1}, {player: 'dee', score: 60, rank: 2}, {player: 'ana', score: 40, rank: 3}], \`top('weekly', 3) must be the three highest scorers, best first, as {player, score, rank} with ranks 1, 2, 3; got \${show(await m.top('weekly', 3))}\`);
  assert.deepEqual(await m.top('weekly', 1), [{player: 'bo', score: 75, rank: 1}], \`top('weekly', 1) is the leader alone; got \${show(await m.top('weekly', 1))}\`);
  assert.deepEqual(await m.top('weekly', 10), expectedOrder(FIVE), \`n larger than the board returns everyone, still ranked 1..5; got \${show(await m.top('weekly', 10))}\`);
  const before = ctx.redisRoundTrips().length;
  await m.top('weekly', 3);
  const sent = ctx.redisRoundTrips().slice(before).flat();
  assert.deepEqual(sent, ['ZREVRANGE'], \`top is one ZREVRANGE … WITHSCORES (members and scores in one reply); it sent \${show(sent)}\`);
}

export async function check_rank_of(ctx) {
  const m = ctx.load('leaderboard');
  await seed(m, 'weekly', FIVE);
  await seed(m, 'monthly', [['bo', 5], ['zed', 90]]);
  for (const {player, score, rank} of await m.top('weekly', 5)) {
    const got = await m.rankOf('weekly', player);
    assert.deepEqual(got, {rank, score}, \`top shows \${player} at rank \${rank} with \${score} points, but rankOf('weekly', '\${player}') says \${show(got)}: rank = ZREVRANK + 1, score = ZSCORE\`);
  }
  assert.equal(await m.rankOf('weekly', 'ghost'), null, 'a player who never scored on the board has no rank: null, not an error and not {rank: 0, score: 0}');
  assert.equal(await m.rankOf('monthly', 'ana'), null, 'boards are independent: ana is on weekly, not on monthly');
  assert.deepEqual(await m.rankOf('monthly', 'bo'), {rank: 2, score: 5}, \`bo leads weekly but is second on monthly with 5 points; rankOf('monthly', 'bo') says \${show(await m.rankOf('monthly', 'bo'))}\`);
}

export async function check_around_clips(ctx) {
  const m = ctx.load('leaderboard');
  await seed(m, 'weekly', SEVEN);
  const rows = expectedOrder(SEVEN);
  assert.deepEqual(await m.around('weekly', 'dee', 2), rows.slice(1, 6), \`around('weekly', 'dee', 2) is bo…fay with ranks 2..6 (two above, dee, two below); got \${show(await m.around('weekly', 'dee', 2))}\`);
  assert.deepEqual(await m.around('weekly', 'ana', 2), rows.slice(0, 3), \`the leader has nobody above: around('weekly', 'ana', 2) must clip to ranks 1..3, not read a negative start from the end of the set; got \${show(await m.around('weekly', 'ana', 2))}\`);
  assert.deepEqual(await m.around('weekly', 'bo', 2), rows.slice(0, 4), \`around('weekly', 'bo', 2): one above (ana, rank 1), bo, two below; got \${show(await m.around('weekly', 'bo', 2))}\`);
  assert.deepEqual(await m.around('weekly', 'gus', 2), rows.slice(4, 7), \`the last player has nobody below: around('weekly', 'gus', 2) is ranks 5..7; got \${show(await m.around('weekly', 'gus', 2))}\`);
  assert.deepEqual(await m.around('weekly', 'fay', 3), rows.slice(2, 7), \`around('weekly', 'fay', 3) clips at the bottom: ranks 3..7; got \${show(await m.around('weekly', 'fay', 3))}\`);
  assert.deepEqual(await m.around('weekly', 'dee', 0), [rows[3]], \`k = 0 is the player alone with the absolute rank 4; got \${show(await m.around('weekly', 'dee', 0))}\`);
  assert.deepEqual(await m.around('weekly', 'dee', 100), rows, \`a window wider than the board is the whole board, ranks 1..7; got \${show(await m.around('weekly', 'dee', 100))}\`);
  assert.deepEqual(await m.around('weekly', 'zed', 2), [], \`a player not on the board has no neighbours: []; got \${show(await m.around('weekly', 'zed', 2))}\`);
}

export async function check_ties(ctx) {
  const m = ctx.load('leaderboard');
  const tied: [string, number][] = [['mia', 50], ['zed', 50], ['abe', 50], ['kim', 80], ['lou', 20], ['bea', 20]];
  await seed(m, 'weekly', tied);
  const rows = expectedOrder(tied);
  assert.deepEqual(await m.top('weekly', 6), rows, \`equal scores are ordered by Redis: in the descending view the greater member comes first (zed, mia, abe at 50; lou before bea at 20); top returned \${show(await m.top('weekly', 6))}\`);
  for (const {player, score, rank} of rows) {
    assert.deepEqual(await m.rankOf('weekly', player), {rank, score}, \`rankOf('weekly', '\${player}') must agree with top: {rank: \${rank}, score: \${score}}, got \${show(await m.rankOf('weekly', player))}\`);
  }
  assert.deepEqual(await m.around('weekly', 'mia', 1), rows.slice(1, 4), \`around('weekly', 'mia', 1) is zed (2), mia (3), abe (4) — the same tie order as top; got \${show(await m.around('weekly', 'mia', 1))}\`);
  assert.deepEqual(await m.around('weekly', 'abe', 1), rows.slice(2, 5), \`around('weekly', 'abe', 1) is mia (3), abe (4), lou (5); got \${show(await m.around('weekly', 'abe', 1))}\`);
  await m.addPoints('weekly', 'abe', 1);
  assert.deepEqual(await m.rankOf('weekly', 'abe'), {rank: 2, score: 51}, \`one more point breaks the tie: abe moves to rank 2 with 51; rankOf says \${show(await m.rankOf('weekly', 'abe'))}\`);
  assert.deepEqual(await m.top('weekly', 3), [{player: 'kim', score: 80, rank: 1}, {player: 'abe', score: 51, rank: 2}, {player: 'zed', score: 50, rank: 3}], \`after abe's point top is kim, abe, zed; got \${show(await m.top('weekly', 3))}\`);
}

export async function check_accumulate(ctx) {
  const m = ctx.load('leaderboard');
  assert.equal(await m.addPoints('weekly', 'ana', 10), 10, 'a new player starts from 0: the first addPoints returns the points given');
  assert.equal(await m.addPoints('weekly', 'ana', 5), 15, 'addPoints accumulates (ZINCRBY): 10 then 5 is 15, not 5 — ZADD would overwrite');
  assert.equal(await m.addPoints('weekly', 'ana', -3), 12, 'negative points subtract: 15 − 3 is 12');
  assert.equal(await m.addPoints('weekly', 'bo', 5), 5, "another player's first score is just their points");
  assert.equal(ctx.redis.zscore('board:weekly', 'ana'), '12', \`the board lives in the sorted set board:weekly with the player as member and the total as score; keys: \${show(ctx.redis.keys('*'))}, ana's score there: \${show(ctx.redis.zscore('board:weekly', 'ana'))}\`);
  assert.deepEqual([...ctx.redis.keys('*')].sort(), ['board:weekly'], \`one key per board, named board:{board}; the keys are \${show(ctx.redis.keys('*'))}\`);
  assert.equal(await m.addPoints('monthly', 'ana', 100), 100, 'the same player on another board starts from 0 there');
  assert.deepEqual(await m.rankOf('weekly', 'ana'), {rank: 1, score: 12}, \`monthly points must not touch weekly: ana still leads weekly with 12; rankOf says \${show(await m.rankOf('weekly', 'ana'))}\`);
  assert.deepEqual(await m.rankOf('monthly', 'ana'), {rank: 1, score: 100});
  assert.deepEqual(await m.top('weekly', 5), [{player: 'ana', score: 12, rank: 1}, {player: 'bo', score: 5, rank: 2}], \`top reflects the accumulated totals; got \${show(await m.top('weekly', 5))}\`);
}

export async function check_remove(ctx) {
  const m = ctx.load('leaderboard');
  await seed(m, 'weekly', FIVE);
  await seed(m, 'monthly', [['bo', 5]]);
  assert.equal(await m.remove('weekly', 'bo'), true, 'removing a player who is on the board returns true');
  assert.equal(await m.rankOf('weekly', 'bo'), null, 'after remove the player has no rank on that board');
  assert.deepEqual(await m.top('weekly', 5), [{player: 'dee', score: 60, rank: 1}, {player: 'ana', score: 40, rank: 2}, {player: 'eli', score: 25, rank: 3}, {player: 'cy', score: 10, rank: 4}], \`with the leader gone everyone moves up one rank; top returned \${show(await m.top('weekly', 5))}\`);
  assert.deepEqual(await m.around('weekly', 'ana', 1), [{player: 'dee', score: 60, rank: 1}, {player: 'ana', score: 40, rank: 2}, {player: 'eli', score: 25, rank: 3}], \`around reflects the new ranks too; got \${show(await m.around('weekly', 'ana', 1))}\`);
  assert.equal(await m.remove('weekly', 'bo'), false, 'removing a player a second time returns false: there was nothing to remove');
  assert.equal(await m.remove('weekly', 'ghost'), false, 'removing a player who never scored returns false');
  assert.deepEqual(await m.rankOf('monthly', 'bo'), {rank: 1, score: 5}, \`remove touches one board only: bo is still on monthly; rankOf says \${show(await m.rankOf('monthly', 'bo'))}\`);
  assert.equal(await m.addPoints('weekly', 'bo', 1), 1, 'a removed player who scores again starts from 0');
}
`,
    go: `package main

import (
	"context"
	"sort"

	"leetbuild/harness"
)

type lbScore struct {
	player string
	points int
}

var (
	lbBg    = context.Background()
	lbFive  = []lbScore{{"ana", 40}, {"bo", 75}, {"cy", 10}, {"dee", 60}, {"eli", 25}}
	lbSeven = []lbScore{{"ana", 70}, {"bo", 60}, {"cy", 50}, {"dee", 40}, {"eli", 30}, {"fay", 20}, {"gus", 10}}
)

func lbAdd(ctx *harness.Ctx, board, player string, points int) int {
	total, err := addPoints(lbBg, board, player, points)
	ctx.NoError(err, "addPoints(%q, %q, %d) returned an error", board, player, points)
	return total
}

func lbSeed(ctx *harness.Ctx, board string, scores []lbScore) {
	for _, s := range scores {
		lbAdd(ctx, board, s.player, s.points)
	}
}

func lbTop(ctx *harness.Ctx, board string, n int) []Row {
	rows, err := top(lbBg, board, n)
	ctx.NoError(err, "top(%q, %d) returned an error", board, n)
	return rows
}

// lbRank is rankOf's answer as a value (a Standing, or nil when it returned nil), so it compares and prints.
func lbRank(ctx *harness.Ctx, board, player string) any {
	s, err := rankOf(lbBg, board, player)
	ctx.NoError(err, "rankOf(%q, %q) returned an error", board, player)
	if s == nil {
		return nil
	}
	return *s
}

func lbAround(ctx *harness.Ctx, board, player string, k int) []Row {
	rows, err := around(lbBg, board, player, k)
	ctx.NoError(err, "around(%q, %q, %d) returned an error", board, player, k)
	return rows
}

func lbRemove(ctx *harness.Ctx, board, player string) bool {
	removed, err := remove(lbBg, board, player)
	ctx.NoError(err, "remove(%q, %q) returned an error", board, player)
	return removed
}

// lbExpected is the spec, independent of the learner: score descending, then member descending (Redis's ZREVRANGE rule).
func lbExpected(scores []lbScore) []Row {
	ordered := append([]lbScore(nil), scores...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].points != ordered[j].points {
			return ordered[i].points > ordered[j].points
		}
		return ordered[i].player > ordered[j].player
	})
	out := make([]Row, len(ordered))
	for i, s := range ordered {
		out[i] = Row{Player: s.player, Score: s.points, Rank: i + 1}
	}
	return out
}

func CheckTopOrder(ctx *harness.Ctx) {
	ctx.Equal(len(lbTop(ctx, "weekly", 3)), 0, "an empty board has no rows: the number of rows top returned")
	lbSeed(ctx, "weekly", lbFive)
	ctx.Equal(lbTop(ctx, "weekly", 3), []Row{{"bo", 75, 1}, {"dee", 60, 2}, {"ana", 40, 3}}, "top(%q, 3) must be the three highest scorers, best first, as {Player Score Rank} with ranks 1, 2, 3", "weekly")
	ctx.Equal(lbTop(ctx, "weekly", 1), []Row{{"bo", 75, 1}}, "top(%q, 1) is the leader alone", "weekly")
	ctx.Equal(lbTop(ctx, "weekly", 10), lbExpected(lbFive), "n larger than the board returns everyone, still ranked 1..5")
	before := len(ctx.Redis.RoundTrips())
	lbTop(ctx, "weekly", 3)
	sent := []string{}
	for _, trip := range ctx.Redis.RoundTrips()[before:] {
		sent = append(sent, trip...)
	}
	ctx.Equal(sent, []string{"ZREVRANGE"}, "top is one ZREVRANGE … WITHSCORES (members and scores in one reply): the commands it sent")
}

func CheckRankOf(ctx *harness.Ctx) {
	lbSeed(ctx, "weekly", lbFive)
	lbSeed(ctx, "monthly", []lbScore{{"bo", 5}, {"zed", 90}})
	for _, row := range lbTop(ctx, "weekly", 5) {
		ctx.Equal(lbRank(ctx, "weekly", row.Player), Standing{Rank: row.Rank, Score: row.Score}, "top shows %s at rank %d with %d points, so rankOf(%q, %q) must agree: Rank = ZREVRANK + 1, Score = ZSCORE", row.Player, row.Rank, row.Score, "weekly", row.Player)
	}
	ctx.Equal(lbRank(ctx, "weekly", "ghost"), nil, "a player who never scored on the board has no rank: nil, not an error and not {0 0}")
	ctx.Equal(lbRank(ctx, "monthly", "ana"), nil, "boards are independent: ana is on weekly, not on monthly")
	ctx.Equal(lbRank(ctx, "monthly", "bo"), Standing{Rank: 2, Score: 5}, "bo leads weekly but is second on monthly with 5 points: rankOf(%q, %q)", "monthly", "bo")
}

func CheckAroundClips(ctx *harness.Ctx) {
	lbSeed(ctx, "weekly", lbSeven)
	rows := lbExpected(lbSeven)
	ctx.Equal(lbAround(ctx, "weekly", "dee", 2), rows[1:6], "around(%q, %q, 2) is bo…fay with ranks 2..6 (two above, dee, two below)", "weekly", "dee")
	ctx.Equal(lbAround(ctx, "weekly", "ana", 2), rows[0:3], "the leader has nobody above: around(%q, %q, 2) must clip to ranks 1..3, not read a negative start from the end of the set", "weekly", "ana")
	ctx.Equal(lbAround(ctx, "weekly", "bo", 2), rows[0:4], "around(%q, %q, 2): one above (ana, rank 1), bo, two below", "weekly", "bo")
	ctx.Equal(lbAround(ctx, "weekly", "gus", 2), rows[4:7], "the last player has nobody below: around(%q, %q, 2) is ranks 5..7", "weekly", "gus")
	ctx.Equal(lbAround(ctx, "weekly", "fay", 3), rows[2:7], "around(%q, %q, 3) clips at the bottom: ranks 3..7", "weekly", "fay")
	ctx.Equal(lbAround(ctx, "weekly", "dee", 0), rows[3:4], "k = 0 is the player alone with the absolute rank 4")
	ctx.Equal(lbAround(ctx, "weekly", "dee", 100), rows, "a window wider than the board is the whole board, ranks 1..7")
	ctx.Equal(len(lbAround(ctx, "weekly", "zed", 2)), 0, "a player not on the board has no neighbours: the number of rows around(%q, %q, 2) returned", "weekly", "zed")
}

func CheckTies(ctx *harness.Ctx) {
	tied := []lbScore{{"mia", 50}, {"zed", 50}, {"abe", 50}, {"kim", 80}, {"lou", 20}, {"bea", 20}}
	lbSeed(ctx, "weekly", tied)
	rows := lbExpected(tied)
	ctx.Equal(lbTop(ctx, "weekly", 6), rows, "equal scores are ordered by Redis: in the descending view the greater member comes first (zed, mia, abe at 50; lou before bea at 20)")
	for _, row := range rows {
		ctx.Equal(lbRank(ctx, "weekly", row.Player), Standing{Rank: row.Rank, Score: row.Score}, "rankOf(%q, %q) must agree with top", "weekly", row.Player)
	}
	ctx.Equal(lbAround(ctx, "weekly", "mia", 1), rows[1:4], "around(%q, %q, 1) is zed (2), mia (3), abe (4): the same tie order as top", "weekly", "mia")
	ctx.Equal(lbAround(ctx, "weekly", "abe", 1), rows[2:5], "around(%q, %q, 1) is mia (3), abe (4), lou (5)", "weekly", "abe")
	lbAdd(ctx, "weekly", "abe", 1)
	ctx.Equal(lbRank(ctx, "weekly", "abe"), Standing{Rank: 2, Score: 51}, "one more point breaks the tie: abe moves to rank 2 with 51")
	ctx.Equal(lbTop(ctx, "weekly", 3), []Row{{"kim", 80, 1}, {"abe", 51, 2}, {"zed", 50, 3}}, "after abe's point top is kim, abe, zed")
}

func CheckAccumulate(ctx *harness.Ctx) {
	ctx.Equal(lbAdd(ctx, "weekly", "ana", 10), 10, "a new player starts from 0: the first addPoints returns the points given")
	ctx.Equal(lbAdd(ctx, "weekly", "ana", 5), 15, "addPoints accumulates (ZINCRBY): 10 then 5 is 15, not 5 (ZADD would overwrite)")
	ctx.Equal(lbAdd(ctx, "weekly", "ana", -3), 12, "negative points subtract: 15 − 3 is 12")
	ctx.Equal(lbAdd(ctx, "weekly", "bo", 5), 5, "another player's first score is just their points")
	score, ok := ctx.Redis.ZScore("board:weekly", "ana")
	ctx.Assert(ok && score == 12, "the board lives in the sorted set board:weekly with the player as member and the total as score; keys: %s, ana's score there: %v (present: %v)", harness.Show(ctx.Redis.Keys("*")), score, ok)
	ctx.Equal(ctx.Redis.Keys("*"), []string{"board:weekly"}, "one key per board, named board:{board}: the keys")
	ctx.Equal(lbAdd(ctx, "monthly", "ana", 100), 100, "the same player on another board starts from 0 there")
	ctx.Equal(lbRank(ctx, "weekly", "ana"), Standing{Rank: 1, Score: 12}, "monthly points must not touch weekly: ana still leads weekly with 12")
	ctx.Equal(lbRank(ctx, "monthly", "ana"), Standing{Rank: 1, Score: 100}, "ana's standing on monthly")
	ctx.Equal(lbTop(ctx, "weekly", 5), []Row{{"ana", 12, 1}, {"bo", 5, 2}}, "top reflects the accumulated totals")
}

func CheckRemove(ctx *harness.Ctx) {
	lbSeed(ctx, "weekly", lbFive)
	lbSeed(ctx, "monthly", []lbScore{{"bo", 5}})
	ctx.Equal(lbRemove(ctx, "weekly", "bo"), true, "removing a player who is on the board returns true")
	ctx.Equal(lbRank(ctx, "weekly", "bo"), nil, "after remove the player has no rank on that board")
	ctx.Equal(lbTop(ctx, "weekly", 5), []Row{{"dee", 60, 1}, {"ana", 40, 2}, {"eli", 25, 3}, {"cy", 10, 4}}, "with the leader gone everyone moves up one rank")
	ctx.Equal(lbAround(ctx, "weekly", "ana", 1), []Row{{"dee", 60, 1}, {"ana", 40, 2}, {"eli", 25, 3}}, "around reflects the new ranks too")
	ctx.Equal(lbRemove(ctx, "weekly", "bo"), false, "removing a player a second time returns false: there was nothing to remove")
	ctx.Equal(lbRemove(ctx, "weekly", "ghost"), false, "removing a player who never scored returns false")
	ctx.Equal(lbRank(ctx, "monthly", "bo"), Standing{Rank: 1, Score: 5}, "remove touches one board only: bo is still on monthly")
	ctx.Equal(lbAdd(ctx, "weekly", "bo", 1), 1, "a removed player who scores again starts from 0")
}
`,
  },
  debrief: `The whole module is two conversions that Redis does for you: **member → position** (\`ZREVRANK\`) and **position range → members** (\`ZREVRANGE\`). \`top\` is the second alone; \`rank_of\` the first; \`around\` the first followed by the second, with the window clamped at 0 *before* it is sent — \`ZREVRANGE key -2 5\` is a valid command that quietly answers from the wrong end of the set, which is why the obvious \`index - k\` fails the clipping check at the top and passes everywhere else. Ranks are numbered from the window's start, not from 1, so a row carries the rank the board shows for it.

Ties are not something to fix on the client. Redis has one order for equal scores — by member, so the greater member comes first in a descending range — and \`ZREVRANK\` reports a position in exactly that order. Re-sorting rows "alphabetically" after the fact gives \`top\` an order that \`rank_of\` contradicts. When a product wants *earliest to the score ranks higher*, real systems encode it into the score (\`points × 2^32 + (MAX − timestamp)\`) so Redis still owns the order. What they add beyond this drill: one key per period (\`board:weekly:2026-W43\`) with a TTL, \`ZREVRANGE\` paging for the full list, \`ZUNIONSTORE\` to roll daily boards into a season, and \`ZRANGEBYSCORE\` for "everyone above 1 000 points".`,
};
