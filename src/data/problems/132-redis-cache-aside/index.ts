import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {fillLockStep} from './steps/1-fill-lock';

/**
 * Cache-aside, the way a product catalogue actually runs it: one key per product with a TTL, a
 * negative sentinel so a missing product does not hit the database on every request, and a fill
 * lock so a hundred concurrent misses on one hot product cost one load, not a hundred.
 */
export const redisCacheAsideProblem: Problem = {
  id: 'redis-cache-aside',
  title: 'Cache-aside with a fill lock and negative caching',
  tagline:
    'One key per product with a TTL, a sentinel for products that do not exist, and a SET NX lock that turns a stampede of misses into one load.',
  difficulty: 'medium',
  concepts: ['redis'],
  minutes: 25,
  statement: `# Cache-aside with a fill lock and negative caching

Cache-aside is the cache pattern every read path ends up with: look in Redis first; on a miss, load from
the slow source, write what came back with a TTL, return it. Done naively it has two famous holes. A product
that does not exist is never written, so every request for it goes to the database — the cheapest denial
of service there is. And when a hot key expires, every request in flight misses at once and the database
takes the whole stampede. Catalogue services, profile services and feature-flag lookups all fix both the
same way: cache the absence too, and let only one request fill a key while the others wait for it.

The surface here is two functions. \`get_product(id, load)\` takes the slow source as an argument — a
function the service would normally wrap around its database client — so what it costs is visible. On a
miss, the first caller takes \`lock:product:{id}\` with \`SET NX EX 5\`, loads, writes \`product:{id}\`
(the JSON for an hour, the sentinel \`__missing__\` for a minute), and deletes the lock; anyone who lost the
lock polls the key every 50 ms until the winner's write lands. \`invalidate(id)\` deletes the key when the
product changes.

## What you build here

1. \`get_product\` and \`invalidate\` over \`product:{id}\` and \`lock:product:{id}\`: hit, miss, sentinel, fill
   lock, bounded wait, and a lock that never survives a failed fill.

## Left out on purpose

Refreshing ahead of expiry, jittered TTLs, request coalescing inside one process, and write-through on
update. One key, one lock, one slow source — the part that decides whether the database sees one load or
a thousand.`,
  diagram: {
    nodes: [
      {id: 'app', kind: 'service', label: 'product service', sub: 'get_product · invalidate', x: 20, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'product:{id} · lock:product:{id}', x: 55, y: 30},
      {id: 'source', kind: 'db', label: 'catalogue DB', sub: 'load(id) — slow', x: 55, y: 70},
    ],
    edges: [
      {from: 'app', to: 'redis', kind: 'redis', label: 'GET · SET NX EX · SET EX · DEL'},
      {from: 'app', to: 'source', kind: 'plain', label: 'load(id) on a miss, lock held'},
    ],
  },
  steps: [fillLockStep],
  learn,
};
