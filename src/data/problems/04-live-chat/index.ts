import type {Problem} from '@/lib/types';

import {presenceStep} from './steps/1-presence';
import {chatStreamStep} from './steps/2-chat-stream';
import {fanOutTopicStep} from './steps/3-fan-out-topic';
import {historyEndpointStep} from './steps/4-history-endpoint';
import {recentCacheStep} from './steps/5-recent-cache';

/**
 * Live chat fan-out: presence with TTL heartbeats in Redis → one gRPC bidirectional stream per
 * client → cross-instance fan-out through a Kafka topic with one consumer group per server → a
 * paginated HTTPS history endpoint → a recent-messages list that seeds joining clients.
 */
export const liveChatProblem: Problem = {
  id: 'live-chat',
  title: 'Live Chat Fan-out',
  tagline:
    'Presence in Redis, a bidi gRPC stream per client, fan-out across servers through Kafka, history over HTTPS.',
  difficulty: 'medium',
  concepts: ['redis', 'grpc', 'kafka', 'http'],
  minutes: 70,
  statement: `# Live Chat Fan-out

A chat room is a fan-out problem: one message in, N copies out — where the N members are spread over
several server instances, every one of them wants to know who else is online, and a newcomer wants to
see what was said before they arrived.

## The real system

Slack or Discord scale: sharded gateways holding millions of long-lived connections, message ordering
across regions, read receipts and typing indicators, search, moderation, push notifications for people
who are offline, and a message store that never loses a line.

## What you build here

A few instances of one service, **chat-server**, behind a load balancer:

1. **Presence** in Redis: a heartbeat key per user with a 30 s TTL, a member set per room, and one
   batched lookup for who is online.
2. A **gRPC bidirectional stream** per client: join a room, say things, receive what others say, and
   clean up when the client hangs up.
3. **Fan-out through Kafka**: every message goes to \`chat-messages\`, and every instance consumes the
   whole topic in its *own* consumer group so it can deliver to the streams it holds.
4. A **paginated HTTPS history endpoint** over the message store, with a short private cache.
5. A **recent-messages list** in Redis that seeds a joining client before live messages flow.

## Left out on purpose

The browser side and WebSockets, authentication, message persistence (the store is given), ordering
guarantees across instances, read receipts, and everything a product adds on top. The five pieces above
are what every live fan-out system — chat, collaborative editing, live dashboards — is built from.`,
  diagram: {
    nodes: [
      {id: 'client-a', kind: 'client', label: 'Client A', sub: 'ana · room-7', x: 9, y: 16},
      {id: 'client-b', kind: 'client', label: 'Client B', sub: 'bo · room-7', x: 9, y: 84},
      {id: 'server-a', kind: 'grpc', label: 'chat-server A', sub: 'Chat(stream) :9000', x: 31, y: 50},
      {id: 'server-b', kind: 'service', label: 'chat-server B', sub: 'group chat-server-b-…', x: 31, y: 84},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'presence:{user} · recent:{room}', x: 55, y: 30},
      {id: 'kafka', kind: 'kafka', label: 'chat-messages', sub: 'key = room id', x: 55, y: 60},
      {id: 'history', kind: 'http', label: 'history API', sub: 'GET /rooms/{room}/messages', x: 79, y: 16},
      {id: 'store', kind: 'db', label: 'message store', sub: 'newest-first pages', x: 79, y: 84},
    ],
    edges: [
      {from: 'client-a', to: 'server-a', kind: 'grpc', label: 'Chat stream'},
      {from: 'client-b', to: 'server-b', kind: 'grpc', label: 'Chat stream'},
      {from: 'server-a', to: 'redis', kind: 'redis', label: 'SET EX · SADD · LPUSH'},
      {from: 'server-a', to: 'kafka', kind: 'kafka', label: 'produce · consume'},
      {from: 'kafka', to: 'server-b', kind: 'kafka', label: 'consume (own group)'},
      {from: 'client-a', to: 'history', kind: 'http', label: 'GET /rooms/{room}/messages'},
      {from: 'history', to: 'store', kind: 'plain', label: 'list(room, before, limit)'},
    ],
  },
  steps: [presenceStep, chatStreamStep, fanOutTopicStep, historyEndpointStep, recentCacheStep],
};
