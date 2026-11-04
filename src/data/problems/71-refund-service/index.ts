import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {refundEndpointStep} from './steps/1-endpoint';
import {refundStateStep} from './steps/2-state';
import {refundDependencyStep} from './steps/3-dependency';
import {refundEventsStep} from './steps/4-events';
import {refundReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Refund service: the debugging you owe a money path before it refunds twice. A validated,
 * idempotent endpoint → one Redis ledger per payment whose claim, release and rebuild are Lua
 * scripts → a PSP call with a deadline and a stable idempotency key that keeps unknown outcomes
 * pending and reconciles them → payment-keyed refund events after confirmation, with an outbox →
 * a read whose totals come from the records and report the ledger's drift.
 */
export const refundServiceProblem: Problem = {
  id: 'refund-service',
  title: 'Refund Service',
  tagline: 'Refunds capped by the payment, one PSP payout per retry, totals finance can reconcile.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Refund Service

A refund service is the part of a payment platform that gives money back. Whether it is safe comes
down to the cap a payment's refunds cannot pass, the key that makes a retry the same refund, the
state a refund keeps while the provider's answer is unknown, and the totals finance reconciles.

## The real system

Stripe's Refunds API is the shape this service copies. A charge can be refunded several times but
not above the amount it captured; every refund is its own object whose \`status\` is \`pending\`,
\`requires_action\`, \`succeeded\`, \`failed\` or \`canceled\`, a failed one names a
\`failure_reason\` such as \`charge_for_pending_refund_disputed\`, and a card refund's
\`destination_details\` carry the acquirer reference number support gives a customer who cannot find
the credit. The merchant's side keeps the same rules: the claim against the cap is atomic, the
provider call carries the refund id as its idempotency key, and an unanswered call leaves the refund
pending until the provider is asked.

## What you build here

One service, **refundd**, on one set of refund records (\`refunds.records\`, provided: payments,
refund rows, Idempotency-Key bindings, the outbox). Step 2's ledger is provided to the later steps
as \`refunds.ledger\`, step 3's PSP client as \`refunds.psp\`.

1. \`POST /v1/refunds\`: the tenant from \`X-Tenant-Id\`, a validated amount and reason code, a
   foreign payment answered **404**, the amount claimed against the payment total (**422** above
   it), and an \`Idempotency-Key\` so a retry answers the first refund.
2. A **Redis** ledger, \`refunded:{payment_id}\`: a hash with no TTL holding the reserved \`total\`
   and one field per refund; \`claim\`, \`release\` and \`rebuild\` are Lua scripts.
3. A **gRPC** PSP client: \`Refund\` with a 5-second deadline and the refund id as
   \`idempotency-key\` on every attempt, three attempts on the codes that leave the outcome unknown,
   a refusal released, an unknown outcome kept \`PENDING\` and reconciled with \`GetRefund\`.
4. A **Kafka** \`refund.event\` per confirmed refund, keyed by payment id, from an idempotent
   producer with \`acks=all\`, and an outbox row when the broker does not take it.
5. \`GET /v1/payments/{id}/refunds\`: totals from the records, the ledger's drift reported, pending
   refunds reconciled with the PSP.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version. A double refund looks like a
happy customer until finance closes the month.

## Left out on purpose

PSP onboarding, settlement timelines, chargebacks and disputes, refund fees, currency conversion,
approval workflows, customer notifications and the accounting export.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Merchant client', sub: 'refund · retry', x: 8, y: 40},
      {id: 'finance', kind: 'external', label: 'Finance', sub: 'read reconciliation', x: 8, y: 86},
      {id: 'api', kind: 'http', label: 'Refund API', sub: 'refundd', x: 26, y: 62},
      {id: 'ledger', kind: 'redis', label: 'Redis ledger', sub: 'refunded:{payment}', x: 48, y: 62},
      {id: 'records', kind: 'db', label: 'refund records', sub: 'rows · keys · outbox', x: 48, y: 86},
      {id: 'psp', kind: 'grpc', label: 'PSP', sub: 'Refund / GetRefund', x: 48, y: 12},
      {id: 'bus', kind: 'kafka', label: 'refund.event', sub: 'key = payment', x: 70, y: 34},
      {id: 'outbox', kind: 'db', label: 'outbox', sub: 'when the broker fails', x: 70, y: 62},
      {id: 'sync', kind: 'service', label: 'Finance sync', sub: 'consumes refund.event', x: 90, y: 34},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/refunds'},
      {from: 'finance', to: 'api', kind: 'http', label: 'GET …/refunds'},
      {from: 'api', to: 'ledger', kind: 'redis', label: 'claim · release (Lua)'},
      {from: 'api', to: 'records', kind: 'plain', label: 'refund rows · keys'},
      {from: 'ledger', to: 'records', kind: 'plain', label: 'rebuild reads the rows'},
      {from: 'api', to: 'psp', kind: 'grpc', label: 'Refund · 5 s · idempotency-key'},
      {from: 'api', to: 'bus', kind: 'kafka', label: 'produce after confirmation'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'no ack → outbox row'},
      {from: 'bus', to: 'sync', kind: 'kafka', label: 'ordered per payment'},
    ],
  },
  steps: [refundEndpointStep, refundStateStep, refundDependencyStep, refundEventsStep, refundReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
