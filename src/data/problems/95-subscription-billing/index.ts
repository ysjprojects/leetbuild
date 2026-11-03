import type {Problem} from '@/lib/types';

import {changePlanStep} from './steps/1-endpoint';
import {billingCursorStep} from './steps/2-state';
import {processorClientStep} from './steps/3-dependency';
import {invoiceEventsStep} from './steps/4-events';
import {invoiceLedgerStep} from './steps/5-read';

/**
 * Subscription billing: the course is not "charge a customer every month", it is the debugging you
 * owe a billing path before it moves real money. A validated plan change prorated over the actual
 * days of the period; one atomic Redis run marker per (subscription, period) claimed before the
 * charge and confirmed after; a processor call with a deadline, an invoice-scoped idempotency key
 * and reconciliation instead of blind retries; invoice events keyed by subscription published
 * after confirmation, failures included, with an outbox; a ledger read that ties out against the
 * processor and keeps other tenants' invoices out of the response.
 */
export const subscriptionBillingProblem: Problem = {
  id: 'subscription-billing',
  title: 'Subscription Billing',
  tagline: 'Plan changes prorated over real days, with a billing run that charges each period once.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Subscription Billing

Subscription billing turns a plan change into money: what a customer owes for the days they had
each plan, which charges reach a processor, what happens when it does not answer, and whether the
customer's numbers match the processor's.

## The real system

Stripe Billing treats a plan change as an interval problem. When a price changes mid-period, it uses
the current period's start and end to credit unused time on the old price and debit the remaining
time on the new one, prorating to the second by default; \`proration_behavior\` decides whether those
items are created at all. A billing run is idempotent per (subscription, period): it claims a marker
before it charges and confirms it with the charge reference after, so a crash in between leaves
evidence a retry can reconcile. The processor call carries a deadline and the invoice id as its
idempotency key, and a timeout is followed by reading the processor's invoice state, not a fresh
charge. Invoices are published keyed by subscription after the processor confirms, and the read side
is a ledger that ties out against the processor's records.

## What you build here

One service, **billingd**, with five pieces:

1. \`POST /v1/subscriptions\`: an authenticated plan change effective \`now\` or at the next period
   boundary, prorated over the **actual** days of the period, with the switch day charged once.
2. A **Redis** billing run per (subscription, period): a marker claimed with \`SET NX\` before the
   charge, confirmed with the invoice reference after, outliving its period, and a closed period
   that refuses a re-charge without an explicit adjustment.
3. A **gRPC** processor client: a **5-second** deadline, the **invoice id** as idempotency key, a
   timeout reconciled by fetching invoice state **before** any retry, and a hard decline that stops
   after one attempt.
4. A **Kafka** \`billing.invoice\` path keyed by subscription id, published after the processor
   confirms, failures included with reasons, and an outbox row when the broker rejects.
5. \`GET /v1/subscriptions/{id}/invoices\`: amounts, credits, payment references and reconciliation
   state from stored invoices, with a foreign subscription answered as **404**.

## The debugging habit

Every starter compiles, serves the happy path and hides flaws. Debug it against the failure modes,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Tax rules, dunning, payment-method vaulting, plan catalogues, credit-note workflows and revenue
recognition.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'plan change · invoices', x: 8, y: 50},
      {id: 'billing', kind: 'http', label: 'Billing Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'billing db', sub: 'invoices · credits · outbox', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'run markers · cursors', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'billing.invoice', sub: 'key = subscription', x: 46, y: 88},
      {id: 'processor', kind: 'grpc', label: 'Payment processor', sub: 'Charge / GetInvoice', x: 70, y: 26},
      {id: 'consumer', kind: 'service', label: 'Ledger projector', sub: 'group billing-ledger', x: 70, y: 76},
    ],
    edges: [
      {from: 'client', to: 'billing', kind: 'http', label: 'HTTPS'},
      {from: 'billing', to: 'db', kind: 'plain', label: 'invoices · outbox'},
      {from: 'billing', to: 'redis', kind: 'redis', label: 'claim · confirm run marker'},
      {from: 'billing', to: 'processor', kind: 'grpc', label: 'Charge / GetInvoice'},
      {from: 'billing', to: 'kafka', kind: 'kafka', label: 'produce billing.invoice'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'project ledger'},
    ],
  },
  steps: [changePlanStep, billingCursorStep, processorClientStep, invoiceEventsStep, invoiceLedgerStep],
};
