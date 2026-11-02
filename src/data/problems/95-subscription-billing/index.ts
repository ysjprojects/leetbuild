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

Subscription billing is the piece of a product that turns a plan change into money: it decides what a
customer owes for the days they actually had each plan, which charges may be sent to a processor,
what happens when the processor does not answer, and whether the numbers a customer sees match the
numbers the processor holds. The visible part is an invoice; the parts that decide whether the
product is safe are the proration arithmetic, the idempotency of a billing run, the failure policy of
a charge, the ordering of the events it publishes, and whether a ledger can be reconciled.

## The real system

Stripe Billing treats a plan change as an interval problem. When a subscription's price changes
mid-period, it uses the current billing period's start and end times to credit the unused time on
the old price and debit the remaining time on the new price, prorating down to the second by
default, and the \`proration_behavior\` parameter decides whether those items are created at all.
A billing run in a system like that is idempotent per (subscription, period): it claims a marker
atomically before it charges and confirms it with the charge reference after, so a crash in between
leaves evidence a retry can reconcile rather than a customer who is charged twice. A closed period
refuses further charges unless an explicit adjustment says otherwise, because a marker that expires
with the month cannot tell a closed period from a new one. The processor call carries a deadline and
the invoice id as its idempotency key, a timeout is followed by reading the processor's invoice state
rather than by a fresh charge, and a hard decline is terminal. Every invoice, charged or failed, is
published keyed by subscription so a subscription's history stays ordered, only after the processor
confirms, with an outbox row when the broker refuses. The read side is a ledger: amounts come from
stored invoices, credits are shown as their own lines, totals tie out against the processor's records
for the same period, and another tenant's subscription is a 404.

## What you build here

One service, **billingd**, with five pieces:

1. \`POST /v1/subscriptions\`: an authenticated tenant, a plan change carrying the new plan, an
   effective date that is \`now\` or the next period boundary, and a proration policy the platform
   implements, with an invoice schedule prorated over the **actual** days of the period and a switch
   day charged exactly once.
2. A **Redis** billing run for each (subscription, period): a generation marker claimed atomically
   with \`SET NX\` before the charge, confirmed with the invoice reference after it, a closed period
   that refuses a re-charge without an explicit adjustment action, and a marker that outlives the
   period it guards.
3. A **gRPC** processor client: a **5-second** deadline per attempt, the **invoice id** as the
   idempotency key, a timeout reconciled by fetching the processor's invoice state **before** any
   retry, and a hard decline that stops after one attempt and marks the invoice failed with a reason.
4. A **Kafka** \`billing.invoice\` path keyed by subscription id so a subscription's billing history
   stays ordered, carrying amounts, periods and processor references, published only after the
   processor confirms, failed attempts included with their reasons, and an outbox row when the
   broker rejects the produce.
5. \`GET /v1/subscriptions/{id}/invoices\`: each period's amount, credits, payment references and
   reconciliation state, computed from stored invoices and tied out against the processor's records
   for the same period, with a foreign subscription answered as **404**.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is the job you will have on a real billing path: debug it
against the failure modes, find the subtle one, fix it, optimize what is wasteful, and prove the fix
with checks that fail on the starter and pass on your version.

## Left out on purpose

Tax and jurisdiction rules, dunning campaigns, payment-method vaulting, plan catalogues and pricing
experiments, credit-note workflows, revenue recognition and the processor's own reconciliation
reports. The five pieces above are the ones that decide whether a bill is correct, charged once and
verifiable.`,
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
