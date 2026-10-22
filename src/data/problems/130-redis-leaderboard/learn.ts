/**
 * The learning guide for the leaderboard drill: the sorted set as an ordered index, the two
 * conversions a leaderboard is made of, the window that must be clipped before it goes negative,
 * and the one tie order every call has to agree on. Rendered at `/redis-leaderboard/learn`.
 */
export const learn = `# The mechanism at a glance

A leaderboard answers three questions: who is on top, where am I, and who is just above and below
me. A Redis **sorted set** answers all three without the client sorting anything, because Redis keeps
the members ordered by score and can report a member's position as a number. The drill is one
module, \`leaderboard\`, over one sorted set \`board:{board}\` per board — member = player, score = points:

:::diagram
{
  "nodes": [
    {"id": "game", "kind": "service", "label": "game server", "sub": "add_points · top · rank_of · around · remove", "x": 25, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "board:{board} — one sorted set per board", "x": 70, "y": 50}
  ],
  "edges": [{"from": "game", "to": "redis", "kind": "redis", "label": "ZINCRBY · ZREVRANGE · ZREVRANK · ZSCORE · ZREM"}]
}
:::

The contract, in one table:

| Function | Redis | Answer |
| --- | --- | --- |
| \`add_points(board, player, points) -> int\` | \`ZINCRBY\` | the player's new total; a new player starts from 0; points may be negative |
| \`top(board, n) -> [(player, score, rank)]\` | one \`ZREVRANGE … WITHSCORES\` | the first \`n\` rows, best first, ranks \`1..n\`; fewer when the board is shorter, \`[]\` when empty |
| \`rank_of(board, player) -> (rank, score) \\| None\` | \`ZREVRANK\` + \`ZSCORE\` | the player's rank and score; \`None\` when not on *that* board |
| \`around(board, player, k) -> [(player, score, rank)]\` | \`ZREVRANK\`, then one \`ZREVRANGE\` | the \`k\` above, the player, the \`k\` below, with **absolute** ranks, clipped at both ends |
| \`remove(board, player) -> bool\` | \`ZREM\` | whether the player was there; everyone below moves up one rank |

Ranks are **1-based** and **descending by score** — rank 1 is the best. Points are integers and are
reported as integers. Boards are independent: a player's points on \`weekly\` say nothing about
\`monthly\`.

# A sorted set is an order you can index into

Redis's
[sorted set](https://redis.io/docs/latest/develop/data-types/sorted-sets/) is a set of unique
members, each with a floating-point score, kept in score order at all times. Internally it is two
structures over the same elements: a hash table from member to score, and a
[skip list](https://en.wikipedia.org/wiki/Skip_list) ordered by score. The hash gives \`ZSCORE\` in
\`O(1)\`; the skip list gives insertion, removal, *and rank lookup* in \`O(log N)\` — the levels of the
skip list carry span counts, so Redis can say "this member is the 3rd from the top" without walking
the list. That last property is the whole reason a leaderboard is a sorted set rather than a hash
of scores: a hash would store the points just as well, but every "where am I" would be a full scan
and a sort.

Two ways to put points in, and only one of them is a leaderboard:

| Command | What it does | \`10\`, then \`5\`, then \`-3\` |
| --- | --- | --- |
| \`ZADD board:weekly 5 ana\` | sets ana's score to 5 — **overwrites** | 10, 5, −3 |
| \`ZINCRBY board:weekly 5 ana\` | adds 5 to ana's score, creating her at 0 first if absent — **accumulates** | 10, 15, 12 |

[\`ZINCRBY\`](https://redis.io/docs/latest/commands/zincrby/) returns the new score as a string, so
\`add_points\` returns that, parsed to an integer. It accepts a negative increment, so a penalty is
the same call. Nothing is read first and nothing is written back: the read-modify-write happens
inside Redis, in one command, so two game servers scoring the same player at the same moment both
land — \`ZADD\` from a value the client read a moment ago would lose one of them.

\`\`\`text
ZINCRBY board:weekly 10 ana     → "10"    (ana did not exist; started from 0)
ZINCRBY board:weekly 5  ana     → "15"
ZINCRBY board:weekly -3 ana     → "12"
ZINCRBY board:monthly 7 ana     → "7"     (a different key: a different score)
\`\`\`

:::quiz
Q: Two game servers each award ana 5 points within the same millisecond. Which call makes both awards count?
- [ ] \`ZSCORE\` on each server, add 5, then \`ZADD\` the result
- [x] \`ZINCRBY board:weekly 5 ana\` on each server
- [ ] \`ZADD\` with the \`NX\` flag so only the first one wins
> Read-then-\`ZADD\` is a lost update waiting to happen: both servers read 10, both write 15. \`ZINCRBY\` is a single command that Redis executes whole, so the second one starts from the first one's result and ana ends on 20.
:::

# Two conversions, and what each costs

Everything the module does is one of two conversions that Redis performs for you — **member →
position** and **position range → members** — and the rest is arithmetic on positions:

:::sequence
{
  "participants": ["game server", "Redis"],
  "messages": [
    {"from": "game server", "to": "Redis", "label": "ZINCRBY board:weekly 15 ana", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "\\"55\\"", "kind": "reply"},
    {"from": "game server", "to": "Redis", "label": "ZREVRANGE board:weekly 0 2 WITHSCORES", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "bo 75 · dee 60 · ana 55 → ranks 1, 2, 3", "kind": "reply"},
    {"from": "game server", "to": "Redis", "label": "ZREVRANK board:weekly ana", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "2 → rank 3", "kind": "reply"},
    {"from": "game server", "to": "Redis", "label": "ZSCORE board:weekly ana", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "\\"55\\" → rank_of = (3, 55)", "kind": "reply"},
    {"from": "game server", "to": "Redis", "label": "ZREVRANGE board:weekly max(0, 2-5)=0 … 7 WITHSCORES", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "the window, numbered from its start: ranks 1…", "kind": "reply"}
  ]
}
:::

- [\`ZREVRANK key member\`](https://redis.io/docs/latest/commands/zrevrank/) — **member → position**,
  0-based, highest score first. \`nil\` for a member that is not in the set. Rank = index + 1.
- [\`ZREVRANGE key start stop WITHSCORES\`](https://redis.io/docs/latest/commands/zrevrange/) —
  **position range → members**, inclusive at both ends, highest score first, members and scores
  interleaved. A \`stop\` past the end is clipped silently; a \`start\` past the end answers an empty list.
- \`top(board, n)\` is the second conversion alone: \`ZREVRANGE board:{board} 0 n-1 WITHSCORES\`, row \`i\`
  gets rank \`i + 1\`. One call, not one per row.
- \`rank_of\` is the first: \`ZREVRANK\` for the position, \`ZSCORE\` for the points; \`None\` if either is
  \`nil\`.
- \`around\` is the first followed by the second, with the window computed between them.

What each one costs, from the command reference — \`N\` members on the board, \`M\` rows returned:

| Call | Complexity | Round trips |
| --- | --- | --- |
| \`ZINCRBY\` | \`O(log N)\` | 1 |
| \`ZSCORE\` | \`O(1)\` | 1 |
| \`ZREVRANK\` | \`O(log N)\` | 1 |
| \`ZREVRANGE start stop\` | \`O(log N + M)\` | 1 |
| \`ZREM\` | \`O(log N)\` per member | 1 |
| \`top\` | \`O(log N + n)\` | 1 |
| \`rank_of\` | \`O(log N)\` | 2 |
| \`around\` | \`O(log N + 2k)\` | 2 |

The number that matters is the one that is *not* in the table: nothing is \`O(N)\`. A board of ten
million players answers "where am I" in a handful of skip-list hops, and \`top(10)\` reads ten
elements from the head of the list. A client that fetched the whole set and sorted it would pay
\`O(N log N)\` and ship the whole board over the wire for every page view.

:::details ZREVRANGE and ZRANGE … REV
Since Redis 6.2 the reference lists \`ZREVRANGE\` as deprecated in favour of
\`ZRANGE key start stop REV\`, which does the same thing with one command name for all the range
flavours. The drill uses \`ZREVRANGE\` because every client library still exposes it under that name
and the semantics — inclusive indices, negative indices from the end, \`WITHSCORES\` interleaving —
are identical. Everything on this page applies to both spellings.
:::

:::quiz
Q: A dashboard shows the top 10 and the viewer's own rank on a board of 2 million players. How much of the board does Redis touch?
- [ ] All of it — a rank needs a sort
- [x] About \`log N\` skip-list hops for the rank and ten elements from the head for the top
- [ ] The top 10 and everyone above the viewer
> The skip list carries span counts, so \`ZREVRANK\` walks down the levels and sums spans: \`O(log N)\`. \`ZREVRANGE 0 9\` finds position 0 the same way and then steps along ten neighbours. Neither looks at the other 1,999,990 players.
:::

# The window around a player, and the negative index

\`around(board, player, k)\` is the obvious composition — \`index = ZREVRANK\`, then
\`ZREVRANGE index-k index+k\` — and the obvious composition is wrong at the top of the board. Redis reads
a **negative** index as "count from the end": \`-1\` is the last member, \`-2\` the one before. So for
the leader, \`index = 0\`, \`k = 2\`:

:::sequence
{
  "participants": ["game server", "Redis"],
  "messages": [
    {"from": "game server", "to": "Redis", "label": "ZREVRANK board:weekly bo", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "0 — bo leads", "kind": "reply"},
    {"from": "game server", "to": "Redis", "label": "naive: ZREVRANGE board:weekly 0-2=-2 0+2=2 WITHSCORES", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "[] — start -2 is the 5th of 6 members, which is after stop 2", "kind": "reply"},
    {"from": "game server", "to": "game server", "label": "around(weekly, bo, 2) = [] — the leader has no neighbours?", "kind": "sync"},
    {"from": "game server", "to": "Redis", "label": "clipped: ZREVRANGE board:weekly max(0, -2)=0 2 WITHSCORES", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "bo 75 · dee 60 · ana 55 → ranks 1, 2, 3", "kind": "reply"}
  ]
}
:::

The command is valid, Redis does not complain, and the answer is quietly from the wrong end of the
set — an empty list on a six-player board, or a few rows with ranks numbered \`-1, 0, 1\` on a
smaller one. The rules that make the window correct:

- **Clip the start before sending it:** \`start = max(0, index - k)\`. The stop needs no clipping — a
  \`stop\` past the last member is clipped by Redis, which is the behaviour you want at the bottom.
- **Number rows from the window's start, not from 1:** row \`i\` has rank \`start + i + 1\`. That is what
  makes the ranks *absolute* — the rank the board shows for that player — rather than positions
  inside the window.
- **A stranger gets an empty list** — \`ZREVRANK\` answered \`nil\`, so there is no index to build a window on.
- **Zero neighbours is the player alone:** \`k = 0\` is a window of \`[index, index]\`, one row, their real rank.

Six players — bo 75, dee 60, ana 55, zed 50, mia 50, kim 40 — and \`k = 2\`:

| Player | \`ZREVRANK\` | Naive \`start stop\` | Clipped \`start stop\` | Rows and ranks |
| --- | --- | --- | --- | --- |
| bo | 0 | \`-2 2\` → \`[]\` | \`0 2\` | bo 1 · dee 2 · ana 3 |
| ana | 2 | \`0 4\` | \`0 4\` | bo 1 · dee 2 · ana 3 · zed 4 · mia 5 |
| kim | 5 | \`3 7\` | \`3 7\` — stop clipped by Redis | zed 4 · mia 5 · kim 6 |

The symptom is the cruel part: the naive version passes for every player except the few near the
top, which is exactly where nobody tests and everybody looks.

:::quiz
Q: \`around\` is implemented as \`ZREVRANGE index-k index+k\` with no clipping. Who gets a wrong answer?
- [ ] Everyone: the ranks are off by one
- [x] Only players within \`k\` of the top — their start goes negative and Redis reads it from the end
- [ ] Only players within \`k\` of the bottom — the stop runs past the last member
> A stop past the end is clipped by Redis; a negative start is not an error but a different index. The leader's window on a six-player board with \`k = 2\` is \`ZREVRANGE -2 2\`: start is position 4, stop is 2, the answer is an empty list, and the code that produced it looks correct.
:::

# Ties: one order, decided once, reported everywhere

Two players on 50 points still have an order — a board prints one above the other — and the
question is who decides it. Redis already has: within equal scores, members are ordered
**lexicographically** (by the bytes of the member string), so in a descending range the
lexicographically **greater** member comes first. \`zed\` ranks above \`mia\` at 50 points. That is the
order \`ZREVRANGE\` returns rows in, and \`ZREVRANK\` reports a position in exactly that order.

The failure is not a crash; it is two calls that disagree:

:::sequence
{
  "participants": ["page", "game server", "Redis"],
  "messages": [
    {"from": "page", "to": "game server", "label": "top(weekly, 5)", "kind": "sync"},
    {"from": "game server", "to": "Redis", "label": "ZREVRANGE board:weekly 0 4 WITHSCORES", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "bo 75 · dee 60 · ana 55 · zed 50 · mia 50", "kind": "reply"},
    {"from": "game server", "to": "game server", "label": "\\"tidy\\" the ties alphabetically: … · mia 50 · zed 50", "kind": "sync"},
    {"from": "game server", "to": "page", "label": "mia #4, zed #5", "kind": "reply"},
    {"from": "page", "to": "game server", "label": "rank_of(weekly, mia)", "kind": "sync"},
    {"from": "game server", "to": "Redis", "label": "ZREVRANK board:weekly mia", "kind": "sync"},
    {"from": "Redis", "to": "game server", "label": "4 → rank 5", "kind": "reply"},
    {"from": "game server", "to": "page", "label": "(5, 50) — the same page says mia is #4 and #5", "kind": "reply"}
  ]
}
:::

- **Do not re-sort rows on the client.** A sort "to fix the ties" gives \`top\` an order that
  \`rank_of\` and \`around\` contradict, because those two come from \`ZREVRANK\`, which only knows Redis's
  order.
- **One rank per player.** \`top\`, \`rank_of\` and \`around\` all derive their numbers from the same
  skip-list positions, so they agree on every player — including the tied ones — for free, as long
  as nothing rearranges the rows after Redis returns them.
- The lexicographic rule is a **stable, deterministic tie-break**, not a fair one: \`zed\` outranks
  \`mia\` for no reason a player would accept. The drill reports it as-is; the fix belongs in the
  score, not in the client.

The same six players, showing why re-sorting cannot work:

| Player | Score | Redis order (rank) | Alphabetical "fix" | \`ZREVRANK\` + 1 |
| --- | --- | --- | --- | --- |
| zed | 50 | 4 | 5 | 4 |
| mia | 50 | 5 | 4 | 5 |

When a product wants *earliest to reach the score ranks higher*, real systems **encode the
tie-break into the score** so that Redis still owns the order — for example
\`points × 2^32 + (MAX − timestamp)\` — and decode it on the way out. A sorted-set score is a
double, so the composite must stay within 53 bits to be exact; that is the budget that shapes the
encoding.

:::quiz
Q: \`top\` shows zed above mia at 50 points, and the product owner would prefer mia first because she got there earlier. Where does the fix go?
- [ ] Sort the rows of \`top\` by timestamp on the client before returning them
- [x] Fold the timestamp into the score so Redis orders them that way for every call
- [ ] Call \`ZREVRANK\` for each row of \`top\` and renumber
> Only Redis can give three different calls one consistent order. A client-side sort fixes \`top\` and breaks \`rank_of\`; renumbering from \`ZREVRANK\` just restores the order you were trying to change. A composite score changes the order at the source, so every call agrees.
:::

# What production boards add

The drill is one set and five functions. What a real game or sales dashboard puts around it, all
from the same primitives:

- **One key per period.** \`board:weekly:2026-W43\` with a TTL, so last month's boards expire on their
  own; "this week" is a key name, not a filter.
- **Rolling up.** \`ZUNIONSTORE season 7 board:d1 … board:d7\` sums daily boards into a season board
  in one command — scores add by default, which is what points do.
- **Paging past the top.** \`ZREVRANGE 100 199\` is page 2; the arithmetic is \`top\`'s.
- **Score ranges.** \`ZRANGEBYSCORE board:weekly 1000 +inf\` for "everyone above 1 000 points",
  \`ZCOUNT\` for how many — both \`O(log N + M)\`.
- **Display names and anti-cheat** live elsewhere: the set holds player ids and points, nothing that
  changes when a name does.

None of these change the shape: one sorted set is the index, the score carries everything the order
depends on, and every rank a user sees is a \`ZREVRANK\` or a \`ZREVRANGE\` offset.

# What to take away

- **A sorted set is an index, not a list of scores.** The skip list's span counts are what turn "where
  am I" from a sort into \`O(log N)\`.
- **Increment, never overwrite.** \`ZINCRBY\` accumulates inside Redis in one command; read-then-write loses
  updates and \`ZADD\` overwrites.
- **Two conversions.** \`ZREVRANK\` turns a member into a position; \`ZREVRANGE\` turns a position range
  into members. \`top\` is the second, \`rank_of\` the first, \`around\` both.
- **Clip before you send.** \`max(0, index - k)\` — a negative start is a valid command that answers from
  the wrong end. Number rows \`start + i + 1\` so ranks are absolute.
- **Ties belong to Redis.** Equal scores order lexicographically, greater member first when
  descending; report it, never re-sort, and when the product wants a different tie-break, put it in
  the score.

The primary reference is the Redis documentation's
[sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) page, with the command
pages for [\`ZINCRBY\`](https://redis.io/docs/latest/commands/zincrby/),
[\`ZREVRANK\`](https://redis.io/docs/latest/commands/zrevrank/) and
[\`ZREVRANGE\`](https://redis.io/docs/latest/commands/zrevrange/) for the exact index and
tie-ordering rules.
`;
