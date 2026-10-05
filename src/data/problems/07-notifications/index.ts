import type {Problem} from '@/lib/types';

import {notifyEndpointStep} from './steps/1-notify-endpoint';
import {userTopicStep} from './steps/2-user-topic';
import {userRateLimitStep} from './steps/3-user-rate-limit';
import {prefsCacheStep} from './steps/4-prefs-cache';
import {pushGatewayStep} from './steps/5-push-gateway';
import {retryConsumerStep} from './steps/6-retry-consumer';

/**
 * Notification service: an idempotent intake API → a per-user ordered Kafka topic → a sliding-window
 * rate limit and a preferences cache in Redis → a push gateway over gRPC with a deadline and jittered
 * retries → a delivery consumer with a retry topic and a dead-letter queue.
 */
export const notificationsProblem: Problem = {
  id: 'notifications',
  title: 'Notification Service',
  tagline:
    'Idempotent intake, a per-user Kafka topic, rate limits and preferences in Redis, a push gateway over gRPC, retries and a DLQ.',
  difficulty: 'medium',
  concepts: ['http', 'kafka', 'redis', 'grpc'],
  minutes: 75,
  statement: `# Notification Service

Every product team wants to ping users: an order shipped, a friend replied, a password changed. One
service takes those requests and gets them to a phone — without duplicates when a caller retries,
without drowning a user in twenty pings an hour, and without losing the ones that matter when the
push provider has a bad minute.

## The real system

A multi-channel notification platform: push, SMS and email providers behind one API, templates and
localisation, per-user preferences and quiet hours, delivery receipts flowing back, open/click
analytics, and a scheduler for digests and campaigns.

## What you build here

One service, **notify**, that accepts \`POST /notifications\` and delivers push notifications:

1. An HTTPS intake endpoint that validates the request and dedupes retries with an \`Idempotency-Key\`.
2. A **Kafka** producer to the \`notifications\` topic keyed by user, with a durable, acknowledged write.
3. A per-user **sliding-window** rate limit in a Redis sorted set: 20 notifications an hour, then drop.
4. A **preferences cache** in Redis with cache-aside reads and invalidation on write.
5. A **gRPC** call to the push gateway with a deadline, jittered backoff, and stale-token handling.
6. A consumer in group \`delivery\` with manual commits, a **retry topic** and a **dead-letter queue**.

## Left out on purpose

SMS and email providers, templates and localisation, delivery receipts and analytics, scheduled
digests, and per-device fan-out (one token per user here). None of them change the shape of the six
pieces above: idempotent intake, ordered per-user delivery, limits and preferences in a cache, a
guarded RPC, and a consumer that never loses a record it has not finished with.`,
  diagram: {
    nodes: [
      {id: 'app', kind: 'client', label: 'Product services', sub: 'POST /notifications', x: 9, y: 50},
      {id: 'api', kind: 'http', label: 'notify API', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'idem:{key} · rl:{user} · prefs:{user}', x: 50, y: 16},
      {id: 'bus', kind: 'kafka', label: 'notifications', sub: 'key = user id · 8 partitions', x: 50, y: 50},
      {id: 'worker', kind: 'service', label: 'delivery', sub: 'consumer group', x: 72, y: 50},
      {id: 'gateway', kind: 'grpc', label: 'Push gateway', sub: 'Send · 3 s deadline', x: 90, y: 26},
      {id: 'retry', kind: 'kafka', label: 'notifications-retry', sub: '+ notifications-dlq', x: 90, y: 74},
      {id: 'db', kind: 'db', label: 'Preferences DB', sub: 'load_prefs · save_prefs', x: 28, y: 84},
    ],
    edges: [
      {from: 'app', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET NX · DEL'},
      {from: 'api', to: 'bus', kind: 'kafka', label: 'produce · acks=all'},
      {from: 'api', to: 'db', kind: 'plain', label: 'save_prefs'},
      {from: 'bus', to: 'worker', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'ZADD · GET prefs'},
      {from: 'worker', to: 'db', kind: 'plain', label: 'load_prefs on miss'},
      {from: 'worker', to: 'gateway', kind: 'grpc', label: 'Send'},
      {from: 'worker', to: 'retry', kind: 'kafka', label: 'retry · dlq'},
      {from: 'retry', to: 'worker', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [notifyEndpointStep, userTopicStep, userRateLimitStep, prefsCacheStep, pushGatewayStep, retryConsumerStep],
};
