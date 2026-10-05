import type {Problem} from '@/lib/types';

import {checkoutIdempotencyStep} from './steps/1-checkout-idempotency';
import {authorizePaymentStep} from './steps/2-authorize-payment';
import {outboxWriteStep} from './steps/3-outbox-write';
import {outboxRelayStep} from './steps/4-outbox-relay';
import {ledgerConsumerStep} from './steps/5-ledger-consumer';
import {merchantRateLimitStep} from './steps/6-merchant-rate-limit';

/**
 * Online merchant transaction system: the money path of a payments platform. Idempotent HTTPS
 * checkout keyed in Redis → provider authorization over gRPC with a deadline and jittered retries →
 * transactional outbox in the order database → relay to Kafka with acks=all → effectively-once
 * ledger consumer deduping in Redis → per-merchant fixed-window rate limit.
 */
export const merchantPaymentsProblem: Problem = {
  id: 'merchant-payments',
  title: 'Online Merchant Transaction System',
  tagline: 'Charge a card once: idempotent checkout, a provider over gRPC, an outbox to Kafka, an exactly-once ledger.',
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'kafka', 'redis'],
  minutes: 90,
  statement: `# Online Merchant Transaction System

A merchant's storefront calls your platform to charge a customer. Networks retry, providers time out,
processes crash mid-request — and through all of it the card must be charged exactly once and the books
must balance.

## The real system

A payments platform (Stripe, Adyen, a bank's acquiring stack): PCI-scoped card vaulting, 3-D Secure
challenges, multi-currency settlement, fraud scoring before authorization, capture separate from
authorization, refunds and chargebacks, and nightly reconciliation against the provider's files.

## What you build here

One service, **checkout**, plus the two workers behind it:

1. An HTTPS \`POST /checkout\` made **idempotent** by an \`Idempotency-Key\` header and a Redis reservation.
2. A **gRPC** call to the payment provider with a deadline, retries only where they are safe, and an honest
   \`PENDING\` when the answer never came.
3. A **transactional outbox**: the order and its \`payment.captured\` event committed in one transaction.
4. A **relay** that publishes committed outbox rows to the \`payments\` topic with \`acks=all\`, marking rows
   sent only after the broker acknowledged them.
5. A **ledger consumer** in group \`ledger\` that applies each event once, deduping on the event id in Redis.
6. A per-merchant **rate limit** — a fixed window of 100 checkouts a minute, one \`INCR\` per request.

## Left out on purpose

Card data (you get a \`card_token\`), fraud scoring, 3-D Secure, currency conversion, refunds, and
reconciliation. They add steps; they do not change the six mechanisms above, which are the ones every
system that moves money ends up with.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Merchant app', sub: 'POST /checkout', x: 8, y: 50},
      {id: 'checkout', kind: 'http', label: 'checkout', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'idem:{key} · rl:{m}:{min} · applied:{id}', x: 58, y: 14},
      {id: 'provider', kind: 'grpc', label: 'PaymentProvider', sub: 'Authorize · 3 s', x: 26, y: 86},
      {id: 'db', kind: 'db', label: 'Postgres', sub: 'orders · outbox', x: 44, y: 50},
      {id: 'relay', kind: 'service', label: 'outbox-relay', sub: 'poll 100 rows', x: 62, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'payments', sub: 'key = merchant id', x: 78, y: 50},
      {id: 'ledger', kind: 'service', label: 'ledger', sub: 'consumer group', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'checkout', kind: 'http', label: 'HTTPS'},
      {from: 'checkout', to: 'redis', kind: 'redis', label: 'SET NX EX · INCR'},
      {from: 'checkout', to: 'provider', kind: 'grpc', label: 'Authorize'},
      {from: 'checkout', to: 'db', kind: 'plain', label: 'orders + outbox (1 tx)'},
      {from: 'relay', to: 'db', kind: 'plain', label: 'SELECT unsent · UPDATE sent'},
      {from: 'relay', to: 'kafka', kind: 'kafka', label: 'produce acks=all'},
      {from: 'kafka', to: 'ledger', kind: 'kafka', label: 'consume'},
      {from: 'ledger', to: 'redis', kind: 'redis', label: 'SET applied NX'},
    ],
  },
  steps: [
    checkoutIdempotencyStep,
    authorizePaymentStep,
    outboxWriteStep,
    outboxRelayStep,
    ledgerConsumerStep,
    merchantRateLimitStep,
  ],
};
