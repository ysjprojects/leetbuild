import type {Problem} from '@/lib/types';

import {leaderboardStep} from './steps/1-leaderboard';

/**
 * Single-topic Redis drill: one sorted set per board, with the rank, neighbours and tie order
 * read straight off ZREVRANK / ZREVRANGE instead of re-sorted on the client.
 */
export const redisLeaderboardProblem: Problem = {
  id: 'redis-leaderboard',
  title: 'Leaderboard: ranks, neighbours and ties',
  tagline:
    'One sorted set per board: ZINCRBY to score, ZREVRANGE for the top, ZREVRANK for a rank, a clipped window for the neighbours, and ties ordered exactly as Redis orders them.',
  difficulty: 'medium',
  concepts: ['redis'],
  minutes: 25,
  statement: `# Leaderboard: ranks, neighbours and ties

A leaderboard answers three questions at once: who is on top, where am I, and who is just above
and below me. A sorted set answers all three in \`O(log N)\` because Redis keeps the members ordered by
score and can report a member's position as a number: \`ZINCRBY\` adds points, \`ZREVRANGE\` lists a
window of the order, \`ZREVRANK\` locates one member in it. Game servers, sales dashboards, trending
lists and "top contributors" widgets all run on this shape.

The part that goes wrong is the **neighbours** query. The window around a player is two ranks
turned into a range, and ranks near the edges become negative indices — which Redis reads as
"count from the end". The other part is **ties**: two players on 50 points have an order, Redis
decides it, and the rank you print next to a name must be the rank Redis used — otherwise \`top\`
says one thing and \`rank_of\` another.

## What you build here

1. The module \`leaderboard\`: \`add_points\`, \`top\`, \`rank_of\`, \`around\` and \`remove\` over one sorted
   set \`board:{name}\` per board, with ranks and tie order taken from Redis.

## Left out on purpose

Time-based boards (daily keys with TTLs), pagination past the top, player display names, anti-cheat,
and tie-breaking by *earliest to reach the score* (which needs a composite score). One set, five
functions, ranks that agree with each other.`,
  diagram: {
    nodes: [
      {id: 'game', kind: 'service', label: 'game server', sub: 'add_points · top · rank_of · around', x: 25, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'board:{name} (sorted set)', x: 70, y: 50},
    ],
    edges: [{from: 'game', to: 'redis', kind: 'redis', label: 'ZINCRBY · ZREVRANGE · ZREVRANK · ZREM'}],
  },
  steps: [leaderboardStep],
};
