/**
 * Catalog of the interactive infographics a step's task may embed with `:::widget name {json}`.
 * Names must match `WIDGET_COMPONENTS` in components/LeetBuild/widgets/index.tsx; the verify
 * script checks both directions.
 */
export interface WidgetSpec {
  /** One-line description shown in authoring checks. */
  about: string;
  /** Parameter names with their meaning and default. */
  params: Record<string, string>;
}

export const WIDGETS: Record<string, WidgetSpec> = {
  'http-lifecycle': {
    about:
      'Playback of one HTTPS request: TCP handshake, TLS handshake (ClientHello, certificate, key exchange), the request line and headers, routing, the handler, the response, and keep-alive reuse.',
    params: {tls: 'show the TLS handshake steps (default true)'},
  },
  'status-codes': {
    about:
      'Which HTTP status to return when: a hoverable map of the codes a service actually uses (200/201/202/204, 400/401/403/404/409/422/429, 500/502/503/504).',
    params: {},
  },
  idempotency: {
    about:
      'Interactive: send the same request twice with the same Idempotency-Key, then with a new key, and watch the key store and the responses (201 created, replayed 201, 409 in-flight).',
    params: {},
  },
  'grpc-streams': {
    about:
      'The four gRPC call types (unary, server streaming, client streaming, bidirectional) as animated message flows over one HTTP/2 stream.',
    params: {mode: "'unary' | 'server' | 'client' | 'bidi' (default 'unary')"},
  },
  'deadline-retry': {
    about:
      'Timeline of retries with exponential backoff and jitter under a caller deadline: sliders for base delay and deadline; shows which attempts fit and which status codes are worth retrying.',
    params: {
      base: 'base delay in ms (default 100)',
      deadline: 'caller deadline in ms (default 2000)',
      attempts: 'max attempts (default 5)',
    },
  },
  'kafka-partitions': {
    about:
      'Interactive: type a message key, see it hashed to a partition and appended at the next offset; explains why per-key ordering holds and cross-partition ordering does not.',
    params: {partitions: 'number of partitions (default 4)'},
  },
  'consumer-groups': {
    about:
      'Slider for the number of consumers in a group against a fixed partition count: partition assignment, idle consumers past the partition count, and committed offsets per partition.',
    params: {partitions: 'number of partitions (default 4)'},
  },
  'delivery-semantics': {
    about:
      'At-most-once, at-least-once and effectively-once side by side: where the commit happens relative to processing, and what a crash between the two does.',
    params: {},
  },
  'cache-aside': {
    about:
      'Playback of the cache-aside pattern: miss → origin → SET with TTL → hits until expiry; a toggle shows a stampede (many concurrent misses) and how a lock or single-flight collapses it.',
    params: {stampede: 'start in the stampede scenario (default false)'},
  },
  'token-bucket': {
    about:
      'Animated token bucket: tokens refill at `rate` per second up to `burst`; click to send requests and watch 200 vs 429.',
    params: {rate: 'tokens per second (default 5)', burst: 'bucket capacity (default 10)'},
  },
  outbox: {
    about:
      'Dual write vs transactional outbox: the database transaction writes the order and the outbox row together; a relay publishes to Kafka and marks rows sent; toggle a crash between the two writes to see the difference.',
    params: {},
  },
  'order-book': {
    about:
      'Interactive limit order book with price-time priority: add bids and asks, watch resting orders queue by price then time, and see fills when the book crosses.',
    params: {},
  },
};

export const WIDGET_NAMES = Object.keys(WIDGETS);
