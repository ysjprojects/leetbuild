import type {Problem} from '@/lib/types';

import {refundEndpointStep} from './steps/1-endpoint';
import {refundStateStep} from './steps/2-state';
import {refundDependencyStep} from './steps/3-dependency';
import {refundEventsStep} from './steps/4-events';
import {refundReadStep} from './steps/5-read';

/**
 * Refund service: the debugging you owe a money path before it refunds twice. Validated,
 * idempotent endpoint → one atomic Redis ledger per payment with a lifetime cap → a PSP call with
 * a deadline and a stable idempotency key that records unknowns as pending → payment-keyed refund
 * events with an outbox and confirm-before-publish → a read endpoint that reconstructs the balance
 * from the durable records and reconciles the cache.
 */
export const refundServiceProblem: Problem = {
  id: 'refund-service',
  title: 'Refund Service',
  tagline: 'Refunds capped by the original payment, with a retry that pays once.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Refund Service

A refund service is the piece of a payment platform that gives money back. The parts that decide
whether it is safe are the cap a refund cannot exceed, the key that makes a retry the same refund,
the state that survives a provider timeout, and the read path finance reconciles against.

## The real system

Stripe's Refunds API is the shape this service copies. A charge may be refunded several times, but
the refunded total cannot exceed the original charge amount; every refund is its own object whose
status moves through \`pending\`, \`succeeded\`, \`failed\` or \`canceled\`, and a
\`refund.updated\` event later carries the acquirer reference number support hands to a customer
who cannot find the credit. The merchant side follows the same rules: the claim against the cap is
atomic, the provider call carries the refund id as its idempotency key so a retry cannot pay twice,
a timeout leaves the refund \`PENDING\` until the provider is asked, and the durable refund records,
not a cache, remain the ledger of record.

## What you build here

One service, **refundd**, with five pieces:

1. \`POST /v1/refunds\`: authenticated tenant, validated amount and reason code, a foreign payment
   answered **404**, an amount above the remaining balance refused with **422**, and an
   \`Idempotency-Key\` so a retry returns the first refund.
2. A **Redis** ledger: one key per payment (\`refunded:{payment_id}\`), no TTL, one atomic Lua
   \`EVAL\` that reads, refuses above the payment total and adds otherwise, and a rebuild from the
   durable refund records.
3. A **gRPC** PSP client: a 5-second deadline, at most three attempts, the refund id as the
   idempotency key on every attempt, \`PENDING\` plus reconciliation for unknown outcomes, and a
   terminal rejection that releases only its reservation.
4. A **Kafka** event path: one \`refund.event\` per confirmed refund keyed by the payment id with
   amount, reason code and PSP reference, an idempotent producer with \`acks=all\`, and an outbox
   row when the broker rejects the produce.
5. \`GET /v1/payments/{id}/refunds\`: the total reconstructed from the durable records, the Redis
   drift reported, pending refunds reconciled with the PSP, and a foreign payment id answered
   **404**.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version. A double refund looks like a happy
customer until finance closes the month.

## Left out on purpose

PSP onboarding, settlement timelines, chargebacks and disputes, refund fees, tax adjustments,
currency conversion, approval workflows, customer notifications and the accounting export.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Merchant client', sub: 'refund · retry', x: 8, y: 40},
      {id: 'finance', kind: 'external', label: 'Finance', sub: 'read reconciliation', x: 8, y: 86},
      {id: 'api', kind: 'http', label: 'Refund API', sub: 'HTTPS :8443', x: 26, y: 62},
      {id: 'ledger', kind: 'redis', label: 'Redis ledger', sub: 'refunded:{payment}', x: 48, y: 62},
      {id: 'records', kind: 'db', label: 'refund records', sub: 'ledger of record', x: 48, y: 86},
      {id: 'psp', kind: 'grpc', label: 'PSP', sub: 'Refund / GetRefund', x: 48, y: 12},
      {id: 'bus', kind: 'kafka', label: 'refund.event', sub: 'key = payment', x: 70, y: 34},
      {id: 'outbox', kind: 'db', label: 'outbox', sub: 'on produce failure', x: 70, y: 62},
      {id: 'reconciler', kind: 'service', label: 'Reconciler', sub: 'group refund-recon', x: 90, y: 34},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/refunds'},
      {from: 'finance', to: 'api', kind: 'http', label: 'GET …/refunds'},
      {from: 'api', to: 'ledger', kind: 'redis', label: 'atomic check-and-add'},
      {from: 'api', to: 'records', kind: 'plain', label: 'refund row · payment · owner'},
      {from: 'api', to: 'psp', kind: 'grpc', label: 'Refund · 5 s · idempotency-key'},
      {from: 'api', to: 'bus', kind: 'kafka', label: 'produce after confirmation'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'on produce failure'},
      {from: 'bus', to: 'reconciler', kind: 'kafka', label: 'consume'},
      {from: 'reconciler', to: 'psp', kind: 'grpc', label: 'GetRefund'},
      {from: 'reconciler', to: 'ledger', kind: 'redis', label: 'rebuild from records'},
      {from: 'reconciler', to: 'records', kind: 'plain', label: 'reconcile row'},
    ],
  },
  steps: [refundEndpointStep, refundStateStep, refundDependencyStep, refundEventsStep, refundReadStep],
};
