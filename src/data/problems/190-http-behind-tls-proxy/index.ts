import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {forwardedHeadersStep} from './steps/1-forwarded-headers';

/**
 * Drill: a plain-HTTP service behind a TLS-terminating load balancer that recovers the client's scheme
 * and address from forwarded headers, but only from its own proxies, then redirects plain http with a
 * 308 and sends HSTS on every https response.
 */
export const httpBehindTlsProxyProblem: Problem = {
  id: 'http-behind-tls-proxy',
  title: 'HTTPS behind a TLS-terminating proxy',
  tagline:
    'Scheme and client IP from X-Forwarded-* only when the peer is a trusted proxy, a right-to-left X-Forwarded-For walk, 308 for plain http and HSTS for https.',
  difficulty: 'medium',
  concepts: ['http'],
  minutes: 25,
  statement: `# HTTPS behind a TLS-terminating proxy

A load balancer accepts the client's HTTPS, decrypts it, and forwards plain HTTP to the service. The
service's own listener therefore sees \`http\` and the balancer's address on every request. The balancer
reports what it saw in \`X-Forwarded-Proto\` and \`X-Forwarded-For\` (RFC 7239 standardises the same as
\`Forwarded\`), and the service must believe those headers from its own proxies and from nobody else. Every
stack has a switch for this (uvicorn \`--proxy-headers\`, Fastify \`trustProxy\`, nginx \`real_ip\`), and the
default of each is easy to get wrong.

The surface:

- \`TRUSTED_PROXIES = {"10.0.0.2", "10.0.0.3"}\`, \`HSTS = "max-age=63072000; includeSubDomains"\`.
- \`GET /whoami\` → 200 \`{"client_ip": …, "scheme": "http" | "https"}\`; \`GET /healthz\` → 200 \`ok\`;
  \`POST /orders\` → 201, appended to \`ORDERS\`.
- From a trusted peer: scheme from the first \`X-Forwarded-Proto\` value, client IP from walking
  \`X-Forwarded-For\` right to left past the trusted hops. From any other peer: no \`X-Forwarded-*\` header counts.
- Effective http, any path but \`/healthz\`: 308, \`Location: https://<Host><path>[?query]\`, empty body, no side
  effect. Effective https: \`Strict-Transport-Security: <HSTS>\` on every response, 404s included, and never
  over http (RFC 6797 §7.2).

## What you build here

1. \`proxy_aware\`: a \`resolve\` that answers the client's address and scheme, a middleware that redirects plain
   http and adds HSTS to https, and the three routes.

## Left out on purpose

Terminating TLS in the service, CIDR ranges in the trust list, parsing RFC 7239 \`Forwarded\`,
\`X-Forwarded-Host\` and \`X-Forwarded-Port\`, the HSTS \`preload\` directive, and \`Secure\` cookies and absolute
links built from the resolved scheme.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: '203.0.113.7 · https', x: 12, y: 50},
      {id: 'lb', kind: 'external', label: 'Load balancer', sub: '10.0.0.2 · 10.0.0.3 · terminates TLS', x: 45, y: 50},
      {id: 'service', kind: 'service', label: 'Service', sub: 'proxy_aware · 308 · HSTS', x: 80, y: 50},
    ],
    edges: [
      {from: 'client', to: 'lb', kind: 'http', label: 'HTTPS'},
      {from: 'lb', to: 'service', kind: 'http', label: 'HTTP · X-Forwarded-*'},
    ],
  },
  steps: [forwardedHeadersStep],
  learn,
};
