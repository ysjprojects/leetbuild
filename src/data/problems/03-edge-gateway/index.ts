import type {Problem} from '@/lib/types';

import {tlsListenerStep} from './steps/1-tls-listener';
import {tokenBucketStep} from './steps/2-token-bucket';
import {grpcProxyStep} from './steps/3-grpc-proxy';
import {auditStreamStep} from './steps/4-audit-stream';
import {responseCacheStep} from './steps/5-response-cache';

/**
 * Rate-limited API gateway: the edge process in front of an internal catalog. TLS listener with
 * graceful shutdown → Redis token bucket in Lua → JSON-to-gRPC proxy with status mapping → an audit
 * stream to Kafka that drops rather than blocks → a ten-second response cache.
 */
export const edgeGatewayProblem: Problem = {
  id: 'edge-gateway',
  title: 'Rate-Limited API Gateway',
  tagline: 'The edge process: TLS, a Redis token bucket, a gRPC proxy, an audit stream, a micro-cache.',
  difficulty: 'easy',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 50,
  statement: `# Rate-Limited API Gateway

Every public API has one process that every request goes through first. It terminates TLS, decides
who may call and how often, translates the outside protocol into the inside one, and writes down what
happened. Everything behind it can assume those four things were done.

## The real system

An API gateway or edge proxy — Envoy, Kong, Traefik, the cloud vendors' gateways: authentication and
JWT validation, a WAF, mTLS to upstreams, request/response transforms, canary routing, distributed
tracing, per-tenant quotas, hot-reloaded configuration, and dashboards for all of it.

## What you build here

One process, **gateway**, that fronts an internal catalog service:

1. An **HTTPS listener** on :8443 with a TLS 1.2 floor, HSTS on every response, and a graceful drain on
   SIGTERM.
2. A **token bucket** per API key in Redis, evaluated atomically in Lua, answering 429 with \`Retry-After\`.
3. A **JSON → gRPC proxy** for \`GET /items/{id}\` with a deadline, request-id propagation and an honest
   status mapping.
4. An **audit stream** to Kafka that never blocks a request — it drops and counts when the broker is behind.
5. A **ten-second response cache** for successful \`GET\`s, with \`X-Cache\` and a \`no-cache\` bypass.

## Left out on purpose

Authentication (the API key is trusted as an identity), the WAF, mTLS to the catalog, configuration
reloads, tracing and metrics export. Each of those slots into the request pipeline you build here without
changing its shape — which is the shape of every gateway you will meet.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'GET /items/{id} · X-API-Key', x: 9, y: 50},
      {id: 'gateway', kind: 'http', label: 'gateway', sub: 'HTTPS :8443', x: 31, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'bucket:{key} · resp:{sha}', x: 55, y: 16},
      {id: 'catalog', kind: 'grpc', label: 'Catalog', sub: 'GetItem · 2 s', x: 55, y: 84},
      {id: 'kafka', kind: 'kafka', label: 'gateway-audit', sub: 'key = api key', x: 70, y: 50},
      {id: 'audit', kind: 'service', label: 'audit-writer', sub: 'consumer group', x: 91, y: 50},
    ],
    edges: [
      {from: 'client', to: 'gateway', kind: 'http', label: 'HTTPS'},
      {from: 'gateway', to: 'redis', kind: 'redis', label: 'EVALSHA · GET / SET EX'},
      {from: 'gateway', to: 'catalog', kind: 'grpc', label: 'GetItem'},
      {from: 'gateway', to: 'kafka', kind: 'kafka', label: 'produce (async)'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [tlsListenerStep, tokenBucketStep, grpcProxyStep, auditStreamStep, responseCacheStep],
};
