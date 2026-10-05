import type {Problem} from '@/lib/types';

import {serveEndpointStep} from './steps/1-serve-endpoint';
import {cacheAsideStep} from './steps/2-cache-aside';
import {stampedeStep} from './steps/3-stampede';
import {resizeRpcStep} from './steps/4-resize-rpc';
import {viewEventsStep} from './steps/5-view-events';
import {countViewsStep} from './steps/6-count-views';

/**
 * Image cache microservice: a thumbnail service in front of an origin store. HTTPS endpoint with
 * validation and cache headers → Redis cache-aside with negative caching → stampede protection →
 * gRPC resizer call with a deadline and bounded retries → view events to Kafka → a consumer
 * counting views in Redis with manual commits.
 */
export const imageCacheProblem: Problem = {
  id: 'image-cache',
  title: 'Image Cache Microservice',
  tagline: 'A thumbnail service: cache-aside in Redis, a resizer over gRPC, view events through Kafka.',
  difficulty: 'medium',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 75,
  statement: `# Image Cache Microservice

Every product page shows dozens of thumbnails. The originals live in an object store and are big; the
page needs them small, fast, and the same bytes for the same request every time.

## The real system

A CDN edge in front of an image proxy (imgix, Cloudinary, a self-hosted Thumbor): signed URLs, dozens of
transforms, WebP/AVIF negotiation, multi-region caches, purge APIs, abuse protection.

## What you build here

One service, **thumbs**, that serves \`GET /img/{id}?w=<width>\`:

1. An HTTPS handler that validates the request and sends the headers browsers and CDNs cache by.
2. A Redis **cache-aside** with a TTL and negative caching for images that do not exist.
3. **Stampede protection**: one render per key when a popular thumbnail expires.
4. A **gRPC** call to an internal resizer with a deadline and bounded retries.
5. A **Kafka** producer emitting one \`image-views\` event per request without slowing it down.
6. A consumer in group \`view-counter\` turning those events into per-image counters in Redis.

## Left out on purpose

Signed URLs, format negotiation, the actual JPEG decoding (\`render\` returns bytes), multi-region
replication and cache purging. None of them change the shape of the six pieces above, which is
what transfers to every other cache you will build.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Browser', sub: 'GET /img/{id}?w=256', x: 9, y: 50},
      {id: 'thumbs', kind: 'http', label: 'thumbs', sub: 'HTTPS :8443', x: 31, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'thumb:{id}:{w} · views:{id}', x: 55, y: 16},
      {id: 'resizer', kind: 'grpc', label: 'Resizer', sub: 'Resize(id, w) · 800 ms', x: 55, y: 84},
      {id: 'origin', kind: 'external', label: 'Origin store', sub: 'originals', x: 80, y: 84},
      {id: 'kafka', kind: 'kafka', label: 'image-views', sub: 'key = image id', x: 70, y: 46},
      {id: 'analytics', kind: 'service', label: 'view-counter', sub: 'consumer group', x: 91, y: 46},
    ],
    edges: [
      {from: 'client', to: 'thumbs', kind: 'http', label: 'HTTPS'},
      {from: 'thumbs', to: 'redis', kind: 'redis', label: 'GET / SET EX'},
      {from: 'thumbs', to: 'resizer', kind: 'grpc', label: 'Resize'},
      {from: 'resizer', to: 'origin', kind: 'plain', label: 'fetch original'},
      {from: 'thumbs', to: 'kafka', kind: 'kafka', label: 'produce'},
      {from: 'kafka', to: 'analytics', kind: 'kafka', label: 'consume'},
      {from: 'analytics', to: 'redis', kind: 'redis', label: 'INCR'},
    ],
  },
  steps: [serveEndpointStep, cacheAsideStep, stampedeStep, resizeRpcStep, viewEventsStep, countViewsStep],
};
