import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {changePlanStep} from './steps/1-endpoint';
import {billingCursorStep} from './steps/2-state';
import {processorClientStep} from './steps/3-dependency';
import {invoiceEventsStep} from './steps/4-events';
import {invoiceLedgerStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Subscription billing: the course is not "charge a customer every month", it is the debugging you
 * owe a billing path before it moves real money. A plan change prorated over the real days of the
 * period → one Redis run marker per (subscription, period), claimed before the charge and confirmed
 * with its reference → a processor client keyed by the invoice that asks before it retries →
 * invoice events keyed by subscription after the outcome is stored, failures included, with an
 * outbox → a ledger read that ties each invoice out against the processor.
 */
export const subscriptionBillingProblem: Problem = {
  id: 'subscription-billing',
  title: 'Subscription Billing',
  tagline: 'Plan changes prorated over real days, with a billing run that charges each period once.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Subscription Billing

Subscription billing turns a plan change into money: what a customer owes for the days on each
plan, which charges reach the processor, what happens when the processor does not answer, and
whether the customer's numbers match the processor's.

## The real system

Stripe Billing prorates a mid-period price change: it credits the unused time on the old price and
charges the remaining time on the new one, down to the second by default, and the
\`proration_behavior\` parameter of a subscription update (\`create_prorations\`, \`always_invoice\`
or \`none\`) decides whether those items are created and whether they are invoiced at once. Around
that sits the shape this course builds: a run that charges each period once, a processor call keyed
by the invoice so a retry is the same charge, invoice events in subscription order, and a ledger
that ties out against the processor.

## What you build here

One service, **billingd**, on three provided modules (the same names in every language):
\`billing.dates\` (ISO days in UTC: \`today\`, \`add_days\`, \`days_between\`; a period is
\`[period_start, period_end)\`), \`billing.store\` (Redis hashes standing in for the billing
database: \`subscription:{id}\`, \`invoice:{id}\` with \`amount_cents\`, \`state\` and \`reference\`,
\`invoice:{id}:credits\`, the \`outbox\` list, \`PLANS\`) and \`billing.processor\` (step 3's client,
provided to the steps that charge or reconcile).

1. \`POST /v1/subscriptions\` \`{subscription_id, plan, effective_date, proration_policy}\` with
   \`X-Tenant-Id\`: the old and new plan priced over the period's real days, and the period's invoice
   opened for the total.
2. \`run_billing(invoice_id)\`: a **Redis** run marker \`billing:run:{subscription_id}:{period_start}\`,
   claimed with \`SET NX\`, confirmed as \`charged:{reference}\`, never expiring.
3. \`charge_invoice(invoice)\` and \`lookup_invoice(invoice_id)\` on the **gRPC**
   \`subbilling.Processor\` (\`Charge\`, \`GetInvoice\`): a 5-second deadline, the invoice id as
   idempotency key, \`GetInvoice\` before a retry, a decline final.
4. \`record_outcome(invoice, outcome)\`: the outcome stored, then a **Kafka** \`billing.invoice\`
   event keyed by subscription id, failures included, and an outbox row when the broker does not
   acknowledge.
5. \`GET /v1/subscriptions/{id}/invoices\`: stored amounts, credits as their own lines, and each
   invoice tied out against \`GetInvoice\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Tax, dunning schedules for failed cards, payment-method storage, plan catalogues, credit-note
workflows and revenue recognition.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'plan change · invoices', x: 8, y: 50},
      {id: 'billing', kind: 'http', label: 'Billing Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'billing store', sub: 'subscriptions · invoices · outbox', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'run markers', x: 46, y: 50},
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
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
