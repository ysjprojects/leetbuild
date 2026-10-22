import type {Problem} from '@/lib/types';

import {refundEndpointStep} from './steps/1-endpoint';
import {refundStateStep} from './steps/2-state';
import {refundDependencyStep} from './steps/3-dependency';
import {refundEventsStep} from './steps/4-events';
import {refundReadStep} from './steps/5-read';

/**
 * Refund service on the AI-era track: the course is not "call the PSP from an endpoint", it is the
 * review you owe a model-generated money path before it refunds twice. Validated, idempotent
 * endpoint → one atomic Redis ledger per payment with a lifetime cap → a PSP call with a deadline
 * and a stable idempotency key that records unknowns as pending → payment-keyed refund events with
 * an outbox and confirm-before-publish → a read endpoint that reconstructs the balance from the
 * durable records and reconciles the cache.
 */
export const refundServiceProblem: Problem = {
  id: 'refund-service',
  title: 'Refund Service',
  tagline: 'Refunds capped by the original payment, executed once, and visible immediately.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Refund Service

A refund service is the piece of a payment platform that gives money back. The visible part is one
number in a support tool; the parts that decide whether the platform is safe are the cap that makes
a refund impossible to exceed, the key that makes a retry the same refund, the state machine that
survives a provider timeout, and the read path finance reconciles against.

## The real system

Refunds are money movement, and money movement is not idempotent by default. A production service
therefore treats every refund as one *intent* with a lifetime: the amount may never exceed what the
customer actually paid, the claim against that cap is atomic so two concurrent partial refunds
cannot both pass the same remaining balance, and the provider call carries the refund id as its
idempotency key so a retry after a timeout cannot pay twice. A timeout is not a failure — it is an
*unknown*, and the honest local state is \`PENDING\` until the provider is asked what happened.
Those unknowns are reconciled before anything is shown to a customer, the durable refund records —
not a cache — remain the ledger of record, and the events that describe the lifecycle are keyed so a
single payment's history stays ordered.

## What you build here

One service, **refundd**, with five pieces:

1. \`POST /v1/refunds\`: authenticated tenant, validated amount (integer, at least 1) and reason
   code, a payment that must belong to the caller (**404** otherwise), an amount above the remaining
   refundable balance refused with **422**, and an \`Idempotency-Key\` so a retry returns the first
   refund instead of paying twice.
2. A **Redis** ledger: one key per payment (\`refunded:{payment_id}\`), a **lifetime** cap with no
   TTL, and one atomic Lua \`EVAL\` that reads, refuses above the payment total and adds otherwise —
   rebuildable at any moment from the durable refund records.
3. A **gRPC** PSP client: a **5-second** deadline per attempt, at most three attempts, the refund id
   as the idempotency key on every attempt, \`PENDING\` plus reconciliation for unknown outcomes, and
   a terminal rejection that releases exactly the reservation it took.
4. A **Kafka** refund event path: one \`refund.event\` per confirmed refund keyed by the **payment**
   id, amounts, reason codes and PSP references in the payload, an idempotent producer with
   \`acks=all\`, and an outbox row when the broker rejects the produce — with nothing published
   before the provider confirms.
5. \`GET /v1/payments/{id}/refunds\`: the refunded total and remaining balance reconstructed from the
   durable records, matched against the Redis ledger with the drift reported, pending refunds
   reconciled with the PSP and called out with their references, and a foreign payment id answered
   with **404**.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version. In a refund service the failures are especially
quiet: a double refund looks like a happy customer until finance closes the month.

## Left out on purpose

PSP account onboarding, bank settlement timelines, chargeback and dispute handling, partial
refund fees, tax adjustments, currency conversion, refund approval workflows, customer
notifications and the accounting export. The five pieces above are the ones that decide whether the
refund path is correct, isolated and shippable.`,
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
