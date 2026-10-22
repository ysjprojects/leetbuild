import type {Problem} from '@/lib/types';

import {slidingWindowStep} from './steps/1-sliding-window';

/**
 * Drill: a sliding-window rate limiter as one Lua script over a sorted set — trim, count, admit,
 * expire and the retry hint in a single atomic round trip, tested under a race between two
 * instances and across the window's edge.
 */
export const redisSlidingWindowLuaProblem: Problem = {
  id: 'redis-sliding-window-lua',
  title: 'A sliding-window limiter in one Lua script',
  tagline:
    'Ten per second, exactly, from two instances at once: trim, count, admit and expire a sorted set in one EVAL and tell the denied caller when to come back.',
  difficulty: 'hard',
  concepts: ['redis'],
  minutes: 35,
  statement: `# A sliding-window limiter in one Lua script

A fixed-window counter lets a client send twice its budget around the minute boundary. A **sliding
window log** does not: every admitted call is a member of a sorted set scored by its timestamp,
calls older than the window are trimmed before counting, and the count against the limit is exact
at any instant. Stripe, Cloudflare and every API gateway with a per-key quota run a version of it;
the sorted set is the canonical Redis shape for it.

The catch is that trim, count and admit are three commands, and two gateway instances serving the
same client interleave them: both count nine, both admit, the client gets eleven. The fix is the
same as for every read-modify-write in Redis — put the whole decision in a **Lua script**, which
Redis runs alone, and pay one round trip per call. The script also knows the oldest member, so a
denied caller gets an exact \`retry_after_ms\` instead of a guess.

The surface is one function: \`allow(client_id, now_ms)\` answering \`(allowed, retry_after_ms)\` with
\`LIMIT = 10\` calls per \`WINDOW_MS = 1000\`, over the key \`sw:{client_id}\`.

## What you build here

1. \`allow\` as a single \`EVAL\` over \`sw:{client_id}\`: \`ZREMRANGEBYSCORE\` below \`now - WINDOW_MS\`,
   \`ZCARD\`, \`ZADD\` when under the limit, \`PEXPIRE WINDOW_MS\`, and on denial the time until the
   oldest member leaves the window — loaded once, called by SHA, no logic outside the script.

## Left out on purpose

Multiple limits per client, weighted calls, the HTTP layer that turns a denial into \`429\` and
\`Retry-After\`, failing open when Redis is down, and the approximated sliding window (two fixed
counters) that trades exactness for memory.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'API callers', sub: 'client_id per request', x: 10, y: 50},
      {id: 'limiter', kind: 'service', label: 'limiter', sub: 'allow(client_id, now_ms)', x: 45, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'sw:{client_id} · one EVAL', x: 80, y: 50},
    ],
    edges: [
      {from: 'client', to: 'limiter', kind: 'plain', label: 'request'},
      {from: 'limiter', to: 'redis', kind: 'redis', label: 'EVALSHA (trim · count · admit · expire)'},
    ],
  },
  steps: [slidingWindowStep],
};
