import type {Problem} from '@/lib/types';

import {lazyRefillStep} from './steps/1-lazy-refill';

/**
 * Drill: a token bucket whose refill is computed lazily from the caller's clock and whose
 * read-refill-compare-write runs as one Lua script — the shape every Redis rate limiter that
 * survives more than one app server has.
 */
export const redisTokenBucketLuaProblem: Problem = {
  id: 'redis-token-bucket-lua',
  title: 'Token bucket with lazy refill, in Lua',
  tagline:
    'One EVAL per decision: refill from the clock, take or deny with a wait, write back, expire — with two servers sharing the bucket and never over-spending.',
  difficulty: 'hard',
  concepts: ['redis'],
  minutes: 35,
  statement: `# Token bucket with lazy refill, in Lua

A token bucket lets a caller spend up to \`CAPACITY\` tokens at once and earns them back at \`RATE\`
tokens per second. Nothing ticks: the bucket is two numbers — how many tokens it held and when that was
— and every decision first *refills* from the time elapsed since, then takes. That is the limiter behind
API gateways (Stripe, GitHub, Cloudflare), per-tenant job admission and outbound-call budgets, because a
burst is allowed and a sustained flood is not.

Shared across many servers, the two numbers live in Redis and the decision must happen *inside* Redis:
a client that reads the hash, computes and writes it back has a window in which another server sees the
same last token. The script runs on one thread, so it decides alone. The caller passes its clock in as
an argument — a script that reads \`TIME\` itself is not a pure function of its inputs.

The surface is one function: \`take(bucket, cost, now_ms)\` → \`(allowed, tokens_left, wait_ms)\`, backed by
the hash \`tb:{bucket}\` with fields \`tokens\` and \`updated_ms\`, \`RATE = 5\`, \`CAPACITY = 20\`.

## What you build here

1. \`take\`: one \`EVAL\` that refills \`min(CAPACITY, tokens + (now - updated) × RATE / 1000)\`, allows and
   subtracts when \`tokens ≥ cost\`, otherwise denies with the milliseconds until it would be possible
   (\`-1\` when \`cost > CAPACITY\`), always writes the hash back and \`PEXPIRE\`s it for the time a full
   refill takes.

## Left out on purpose

Per-route and global buckets, \`SCRIPT LOAD\`/\`EVALSHA\` caching and the \`NOSCRIPT\` fallback, failing open
when Redis is unreachable, and the HTTP headers (\`Retry-After\`, \`X-RateLimit-Remaining\`) a gateway
derives from the three numbers this function returns.`,
  diagram: {
    nodes: [
      {id: 'service', kind: 'service', label: 'API servers', sub: 'take(bucket, cost, now_ms)', x: 25, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'tb:{bucket} · tokens · updated_ms', x: 70, y: 50},
    ],
    edges: [{from: 'service', to: 'redis', kind: 'redis', label: 'EVAL (refill · take · HSET · PEXPIRE)'}],
  },
  steps: [lazyRefillStep],
};
