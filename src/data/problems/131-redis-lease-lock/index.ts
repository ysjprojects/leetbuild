import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {leaseLockStep} from './steps/1-lease-lock';

/**
 * Single-topic Redis drill: a lock taken with SET NX PX, released and extended by compare-and-write
 * scripts that act only while the key still names the caller.
 */
export const redisLeaseLockProblem: Problem = {
  id: 'redis-lease-lock',
  title: 'A lock with a lease, released safely',
  tagline:
    'SET NX PX to take a lock for a bounded time; a Lua compare-and-delete and compare-and-PEXPIRE so only the owner can release or extend it — and a late release never frees the next owner.',
  difficulty: 'medium',
  concepts: ['redis'],
  minutes: 25,
  statement: `# A lock with a lease, released safely

A distributed lock in Redis is one key whose existence means "taken". \`SET key owner NX PX ttl\`
takes it only if nobody has, and gives it a **lease**: a worker that crashes mid-job never releases,
so the lock must free itself. Cron singletons, "one deploy at a time" guards, cache stampede
breakers and job schedulers all run on this three-function surface.

The subtle half is **giving the lock back**. A worker that was paused past its lease is no longer the
holder, but it does not know that; if its \`release\` is a plain \`DEL\`, it deletes the lock the next
worker just took, and two workers run the critical section at once. So every write after the first
compares the key's value to the caller's **owner** token and runs that compare on the server, in a
Lua script — a \`GET\` from the client followed by a \`DEL\` has the same gap in a different place.

## What you build here

1. The module \`lease_lock\`: \`acquire(name, owner, ttl_ms)\`, \`release(name, owner)\` and
   \`extend(name, owner, ttl_ms)\` over one key \`lock:{name}\`, where only the owner can release or
   extend, and a lapsed lease is acquirable by anyone.

## Left out on purpose

Retry and backoff while waiting for the lock, a heartbeat thread that extends it, fencing tokens
checked by the protected resource, and Redlock across several instances. One key, three functions,
and a race the harness actually runs.`,
  diagram: {
    nodes: [
      {id: 'worker', kind: 'service', label: 'workers', sub: 'acquire · extend · release (owner = uuid)', x: 25, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'lock:{name} = owner, PX lease', x: 70, y: 50},
    ],
    edges: [{from: 'worker', to: 'redis', kind: 'redis', label: 'SET NX PX · EVAL compare-and-DEL / PEXPIRE'}],
  },
  steps: [leaseLockStep],
  learn,
};
