import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {delayedJobsStep} from './steps/1-delayed-jobs';

/**
 * Redis drill: a delayed-job queue — a sorted set scored by due time, one Lua script that selects
 * and claims what is due, exponential backoff on failure, a dead list after the fifth.
 */
export const redisDelayedJobsProblem: Problem = {
  id: 'redis-delayed-jobs',
  title: 'Delayed jobs: schedule, pop what is due, back off on failure',
  tagline:
    'A sorted set by due time, one Lua script that claims what is due so two workers never share a job, and a doubling backoff that ends in a dead list.',
  difficulty: 'hard',
  concepts: ['redis'],
  minutes: 35,
  statement: `# Delayed jobs

"Send this email in ten minutes; if it fails, try again later, but not forever." Every job system has
a delayed queue, and in Redis it is a sorted set: the member is the job id, the score is the
millisecond it becomes due, and \`ZRANGEBYSCORE -inf now\` is "what is due". Sidekiq's scheduled set,
Celery's Redis broker and BullMQ's delayed jobs all work this way; so does every rate-limited retry
queue that sits in front of a flaky third-party API.

The hard part is not the schedule, it is the pop. Several workers poll the same set, and a worker
that reads the due ids and then removes them in a second command leaves a window in which another
worker reads the same ids — the job runs twice. The read and the remove have to be one atomic
claim, which in Redis means one Lua script. The second part is what happens when a job fails: count
the failure, put the job back at \`now + backoff\` with the delay doubling from 1 s and capped at
60 s, and after the fifth failure stop retrying and park it on a dead list someone can inspect.

## What you build here

1. One module — \`schedule\`, \`pop_due\`, \`backoff_ms\`, \`fail\`, \`complete\` — over the keys
   \`jobs:delayed\` (sorted set), \`jobs:payload\` and \`jobs:attempts\` (hashes) and \`jobs:dead\` (list),
   with \`pop_due\` as a single Lua script.

## Left out on purpose

The worker loop itself, a processing set with a visibility timeout for workers that crash mid-job,
retry jitter, priorities, and \`EVALSHA\`. The drill is the atomic claim and the backoff arithmetic.`,
  diagram: {
    nodes: [
      {id: 'scheduler', kind: 'client', label: 'scheduler', sub: 'schedule(job, payload, run_at)', x: 10, y: 50},
      {id: 'worker', kind: 'service', label: 'worker', sub: 'pop_due · fail · complete', x: 45, y: 50},
      {
        id: 'redis',
        kind: 'redis',
        label: 'Redis',
        sub: 'jobs:delayed · jobs:payload · jobs:attempts · jobs:dead',
        x: 80,
        y: 50,
      },
    ],
    edges: [
      {from: 'scheduler', to: 'redis', kind: 'redis', label: 'HSET payload · ZADD delayed'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'EVAL pop · HINCRBY · ZADD / RPUSH dead'},
    ],
  },
  steps: [delayedJobsStep],
  learn,
};
