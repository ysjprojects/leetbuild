import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {visibilityTimeoutStep} from './steps/1-visibility-timeout';

/**
 * Drill: a reliable work queue on Redis — jobs move from a ready list into an inflight sorted set
 * under a visibility deadline, inside one Lua script, and come back when nobody acks in time.
 */
export const redisReliableQueueProblem: Problem = {
  id: 'redis-reliable-queue',
  title: 'A work queue with visibility timeouts',
  tagline:
    'Claim, ack and requeue as three Lua scripts: a job is always in exactly one of ready or inflight, and a worker that goes quiet loses it to the next one.',
  difficulty: 'hard',
  concepts: ['redis'],
  minutes: 35,
  statement: `# A work queue with visibility timeouts

A list is a queue until a worker crashes with a job in its hands: \`LPOP\` handed it over, nothing
remembers it, and the job is gone. The fix every queue converges on — SQS, Celery's acks-late,
Sidekiq Pro, Kafka's consumer groups in their own way — is a **visibility timeout**: a claimed job
leaves the ready queue and is parked with a deadline; the worker **acks** when done, and a sweeper
puts back whatever is still parked past its deadline so another worker picks it up. The job is at
least once, never zero times.

On Redis that is four keys per queue \`q:{name}\`: a hash of payloads, a ready list, an inflight
sorted set scored by deadline, and a hash recording which worker owns what. The transitions between
them are multi-key, so each one is a Lua script: \`claim\` pops, parks and records the owner in one
step; \`ack\` removes all three entries but only for the owner; \`requeue_expired\` sweeps every
member whose deadline has passed back to the head of the list.

## What you build here

1. \`enqueue(name, job_id, payload)\`, \`claim(name, worker, visibility_s, now)\`,
   \`ack(name, job_id, worker)\`, \`requeue_expired(name, now)\` and \`stats(name)\` over
   \`q:{name}:jobs\`, \`q:{name}:ready\`, \`q:{name}:inflight\` and \`q:{name}:owner\` — the three
   transitions as single scripts, graded under a probe that lands another worker between two
   commands.

## Left out on purpose

Blocking pops, retry counts and a dead-letter list, heartbeats that extend a deadline, priorities,
and the background loop that calls \`requeue_expired\` on a timer. The scripts are the mechanism;
everything else is a caller.`,
  diagram: {
    nodes: [
      {id: 'producer', kind: 'client', label: 'producer', sub: 'enqueue(name, job_id, payload)', x: 10, y: 30},
      {id: 'worker', kind: 'service', label: 'workers', sub: 'claim · ack · requeue_expired', x: 10, y: 70},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'q:{name}:jobs · ready · inflight · owner', x: 60, y: 50},
    ],
    edges: [
      {from: 'producer', to: 'redis', kind: 'redis', label: 'HSETNX jobs · RPUSH ready'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'EVALSHA claim / ack / requeue'},
    ],
  },
  steps: [visibilityTimeoutStep],
  learn,
};
