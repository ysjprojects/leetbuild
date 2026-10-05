import type {Problem} from '@/lib/types';

import {orderGatewayStep} from './steps/1-order-gateway';
import {publishOrdersStep} from './steps/2-publish-orders';
import {matchConsumerStep} from './steps/3-match-consumer';
import {topOfBookStep} from './steps/4-top-of-book';
import {streamTicksStep} from './steps/5-stream-ticks';
import {bookSnapshotStep} from './steps/6-book-snapshot';

/**
 * Match engine: an exchange in miniature. HTTPS order gateway with auth, validation and an
 * Idempotency-Key → orders to Kafka keyed by symbol with acks=all and the request waiting for the
 * ack → a matching consumer owning one book per partition, emitting trades before committing →
 * top of book in Redis updated and published in one MULTI/EXEC → gRPC server-streaming ticks
 * (snapshot, then Pub/Sub, ending on cancel) → a never-cached GET /book/{symbol}.
 */
export const matchEngineProblem: Problem = {
  id: 'match-engine',
  title: 'Match Engine',
  tagline: 'An exchange in miniature: orders through Kafka by symbol, a price-time book, ticks over gRPC.',
  difficulty: 'hard',
  concepts: ['http', 'kafka', 'redis', 'grpc'],
  minutes: 90,
  statement: `# Match Engine

Every order sent to an exchange ends up in a matching engine: a single-threaded loop per instrument that keeps
a limit order book and crosses incoming orders against resting ones, strictly by price, then by time. Everything
around that loop exists to feed it reliably, in order, and to tell the world what it did.

## The real system

FIX gateways with session sequence numbers, pre-trade risk checks, a dozen order types (IOC, FOK, iceberg,
stop), a sequencer that stamps every input and replicates the log to hot standbys before acknowledging,
deterministic replay for recovery, multicast market data with gap fill, and clearing after the close.

## What you build here

Four services around one provided price-time \`Book\`:

1. An HTTPS **order gateway**: \`POST /orders\` with an API key, validation, an \`Idempotency-Key\`, and a **202**.
2. A Kafka producer that publishes to \`orders\` **keyed by symbol** and waits for \`acks=all\` before the 202 goes out.
3. The **engine**: consumer group \`engine\`, one book per symbol, one \`trades\` record per fill, commit after the trades.
4. **Top of book** in Redis: \`book:{symbol}\` updated and \`ticks:{symbol}\` published in one \`MULTI\`/\`EXEC\`.
5. A **gRPC server stream** of ticks: snapshot from the hash first, then Pub/Sub, ending when the client goes away.
6. \`GET /book/{symbol}\`: the current top of book, validated, \`404\` when absent, never cached.

## Left out on purpose

Risk checks, order types beyond limit, cancels and amends, replication and deterministic replay, market-data
sequence numbers, and the \`Book\` itself (it is provided). The partition key, the position of the commit, the
transaction around the publish and the lifecycle of the stream are the parts that transfer to every system where
order matters.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Trader', sub: 'POST /orders · SubscribeTicks', x: 8, y: 50},
      {id: 'gateway', kind: 'http', label: 'gateway', sub: 'HTTPS :8443', x: 25, y: 50},
      {id: 'orders', kind: 'kafka', label: 'orders', sub: 'key = symbol', x: 42, y: 50},
      {id: 'engine', kind: 'service', label: 'engine', sub: 'group engine · Book per symbol', x: 59, y: 50},
      {id: 'trades', kind: 'kafka', label: 'trades', sub: 'key = symbol', x: 76, y: 18},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'book:{symbol} · ticks:{symbol}', x: 76, y: 82},
      {id: 'ticks', kind: 'grpc', label: 'ticks', sub: 'SubscribeTicks stream :9100', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'gateway', kind: 'http', label: 'HTTPS'},
      {from: 'gateway', to: 'orders', kind: 'kafka', label: 'produce · acks=all'},
      {from: 'orders', to: 'engine', kind: 'kafka', label: 'consume'},
      {from: 'engine', to: 'trades', kind: 'kafka', label: 'one per fill'},
      {from: 'engine', to: 'redis', kind: 'redis', label: 'MULTI HSET PUBLISH EXEC'},
      {from: 'redis', to: 'ticks', kind: 'redis', label: 'HGETALL · SUBSCRIBE'},
      {from: 'ticks', to: 'client', kind: 'grpc', label: 'stream Tick'},
      {from: 'gateway', to: 'redis', kind: 'redis', label: 'HGETALL (GET /book)'},
    ],
  },
  steps: [orderGatewayStep, publishOrdersStep, matchConsumerStep, topOfBookStep, streamTicksStep, bookSnapshotStep],
};
