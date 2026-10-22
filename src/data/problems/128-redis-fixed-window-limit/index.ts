import type {Problem} from '@/lib/types';

import {fixedWindowStep} from './steps/1-fixed-window';

/**
 * One Redis mechanism, drilled alone: the fixed-window rate limit — one INCR per request on a key
 * named after the client and the current minute, an EXPIRE on the first hit, the TTL as the
 * Retry-After when the window is full.
 */
export const redisFixedWindowLimitProblem: Problem = {
  id: 'redis-fixed-window-limit',
  title: 'Fixed-window rate limit',
  tagline:
    'INCR a per-client, per-minute key, EXPIRE it on the first hit, deny past 100 with the TTL as Retry-After — the simplest limiter that survives concurrent workers.',
  difficulty: 'easy',
  concepts: ['redis'],
  minutes: 12,
  statement: `# Fixed-window rate limit

The cheapest rate limiter there is: time is cut into fixed windows of 60 seconds, every client gets
a counter per window, and a request is allowed while its window's counter is at or below the limit.
In Redis the counter is a string key named after the client **and the window number**, bumped with
one \`INCR\`; a key that nobody touches again disappears on its own because the first request gave
it a TTL. There is no sweeper, no list of timestamps, no Lua.

API gateways (Kong, Envoy's local rate limit, GitHub's REST quotas) ship exactly this shape as the
default policy: it costs one round trip per request, it is correct across any number of workers
because the increment happens on the server, and its one known weakness — twice the limit can slip
through around a window boundary — is a documented trade-off, not a bug.

The surface is one function: \`allow(client_id) -> (allowed, retry_after_s)\`. The limit is
\`LIMIT = 100\` per \`WINDOW_S = 60\` seconds; the key is \`rl:{client_id}:{window}\` with
\`window = now // 60\`; a denied call answers the key's remaining TTL (at least 1) so the caller can
set \`Retry-After\`.

## What you build here

1. \`allow(client_id)\`: compute the window, \`INCR rl:{client_id}:{window}\`, \`EXPIRE 60\` when that
   returned 1, allow while the count is \`<= LIMIT\`, otherwise deny with \`TTL\` as \`retry_after_s\`.

## Left out on purpose

Sliding windows and token buckets, per-route or per-plan limits, the HTTP 429 itself, and the Lua
script that folds INCR and EXPIRE into one atomic step. This drill is the one command pattern every
other limiter is compared against.`,
  diagram: {
    nodes: [
      {id: 'gateway', kind: 'service', label: 'API gateway', sub: 'allow(client_id) per request', x: 20, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'rl:{client_id}:{window} · TTL 60', x: 70, y: 50},
    ],
    edges: [{from: 'gateway', to: 'redis', kind: 'redis', label: 'INCR · EXPIRE on 1 · TTL when full'}],
  },
  steps: [fixedWindowStep],
};
