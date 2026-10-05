import type {Problem} from '@/lib/types';

import {postEndpointStep} from './steps/1-post-endpoint';
import {fanoutWorkerStep} from './steps/2-fanout-worker';
import {timelineReadStep} from './steps/3-timeline-read';
import {hydratePostsStep} from './steps/4-hydrate-posts';
import {likePostStep} from './steps/5-like-post';
import {engagementRollupStep} from './steps/6-engagement-rollup';

/**
 * News feed: a post API that publishes to Kafka → a fan-out-on-write worker pushing post ids into
 * Redis timelines (with a celebrity threshold) → a timeline read that merges pushed and pulled ids →
 * batched hydration over gRPC behind an MGET cache → an idempotent like path emitting engagement
 * events → a deduplicating rollup consumer.
 */
export const newsFeedProblem: Problem = {
  id: 'news-feed',
  title: 'News Feed',
  tagline:
    'A home timeline: fan-out on write through Kafka into Redis, pull for celebrities, batched hydration over gRPC.',
  difficulty: 'hard',
  concepts: ['http', 'kafka', 'redis', 'grpc'],
  minutes: 90,
  statement: `# News Feed

Open the app and the first screen is a list of posts from the people you follow, newest first, that
loads in well under a second — even though you follow a thousand accounts and one of them has fifty
million followers.

## The real system

Twitter's and Instagram's home timelines: ranking models over hundreds of candidates, ads and
"suggested for you" injection, media pipelines, multi-region fan-out, spam and abuse filters, and a
cache tier sized for hundreds of millions of daily users.

## What you build here

One service, **feed**, with its workers:

1. An HTTPS API: \`POST /posts\` validates, saves, and publishes a post; \`GET /feed\` pages a timeline.
2. A **Kafka** fan-out worker that pushes every new post id into each follower's Redis timeline — unless
   the author is a **celebrity**, whose posts are pulled instead (the hybrid model).
3. The **timeline read**: one Redis pipeline that fetches the pushed ids and the followed celebrities'
   recent posts, merges them by time, and returns a page with a cursor.
4. **Hydration**: ids become posts through an \`MGET\` cache and one batched **gRPC** call for the misses.
5. An **idempotent like**: a Redis set guards the counter, and every like becomes an engagement event.
6. A rollup consumer that dedupes engagement events by id and keeps per-post statistics.

## Left out on purpose

Ranking, ads, media uploads, the follow graph's own storage (\`graph.followers\` is given), rate limits,
and multi-region replication. None of them change the shape of the six pieces above — push vs pull,
batching, idempotent counters — which is what every feed-shaped system is made of.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'App', sub: 'POST /posts · GET /feed', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'feed-api', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'posts', kind: 'kafka', label: 'posts', sub: 'key = author id', x: 48, y: 18},
      {id: 'fanout', kind: 'service', label: 'fanout', sub: 'consumer group', x: 70, y: 18},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'timeline:{user} · post:{id}', x: 90, y: 50},
      {id: 'postsvc', kind: 'grpc', label: 'PostService', sub: 'GetPosts(ids) · 800 ms', x: 48, y: 82},
      {id: 'engagement', kind: 'kafka', label: 'engagement', sub: 'key = post id', x: 70, y: 82},
      {id: 'rollup', kind: 'service', label: 'engagement-rollup', sub: 'consumer group', x: 90, y: 82},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'posts', kind: 'kafka', label: 'publish'},
      {from: 'posts', to: 'fanout', kind: 'kafka', label: 'consume'},
      {from: 'fanout', to: 'redis', kind: 'redis', label: 'LPUSH · LTRIM'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'LRANGE · MGET · SADD'},
      {from: 'api', to: 'postsvc', kind: 'grpc', label: 'GetPosts'},
      {from: 'api', to: 'engagement', kind: 'kafka', label: 'like events'},
      {from: 'engagement', to: 'rollup', kind: 'kafka', label: 'consume'},
      {from: 'rollup', to: 'redis', kind: 'redis', label: 'HINCRBY'},
    ],
  },
  steps: [postEndpointStep, fanoutWorkerStep, timelineReadStep, hydratePostsStep, likePostStep, engagementRollupStep],
};
