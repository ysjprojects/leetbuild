import type {Problem} from '@/lib/types';

import {invoiceEndpointStep} from './steps/1-endpoint';
import {invoiceStateStep} from './steps/2-state';
import {invoiceDependencyStep} from './steps/3-dependency';
import {invoiceEventsStep} from './steps/4-events';
import {invoiceReadStep} from './steps/5-read';

/**
 * Invoice service on the AI-era track: the course is not "POST an invoice and store it", it is the
 * review you owe a model-generated billing service before it issues a document a business is taxed
 * on. Drafts stay editable → finalization takes a per-tenant number atomically → tax is quoted under
 * a deadline and an unsure answer holds the invoice → lifecycle events are keyed by invoice with
 * line digests → the read serves the issuer's copy and the customer's copy from one stored invoice.
 */
export const invoiceServiceProblem: Problem = {
  id: 'invoice-service',
  title: 'Invoice Service',
  tagline: 'Invoices that number once, tax before finalize and never mutate after issuance.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Invoice Service

An invoice is the one document a business is legally allowed to be chased for, so an invoice service
is less about storing line items and more about the promises it keeps: a number is issued once, tax
is decided before the document exists, and nothing about a finalized invoice ever changes again —
not the line items, not the customer's view of it, not the events another team already consumed.

## The real system

Production invoice services keep drafts cheap and finals expensive. A draft is a mutable container
of line items; finalization is a one-way transition that validates the totals, takes the next number
from a per-tenant sequence without leaving gaps, resolves tax, and only then makes the document
visible. Because numbering is gapless per tenant, the claim must be atomic with the finalize
transition: two concurrent finalizes that both read the last number will both write the same number,
and a claim taken before validation burns a number that no invoice will ever carry. Tax is not
computed locally from a table that goes stale on the first rule change; it is quoted by a tax
service under a deadline, and when that service cannot answer, the honest outcome is to hold the
invoice, not to issue it with zero tax and hope a reconciliation nobody wrote discovers the
difference. Every lifecycle change — created, finalized, sent, paid — is published to one topic
keyed by the invoice id so a consumer sees one invoice's history in order, carrying totals and
digests of the lines instead of the customer's own words and prices, because a topic is retained,
replicated and read by people who were never granted the invoice. And the read is not one payload
for everyone: the issuer sees line items, tax breakdown, internal notes and history; the customer
sees their own document, only once it exists, and only if it is theirs.

## What you build here

One service, **invoiced**, with five pieces:

1. \`POST /v1/invoices\` plus \`PATCH /v1/invoices/{id}\` and
   \`POST /v1/invoices/{id}/finalize\`: validated line items and currency on create, an update that
   a finalized invoice rejects with **409**, an empty invoice that cannot finalize, and a finalized
   invoice that a retry replays instead of recreating.
2. A **Redis** sequence: one atomic claim per tenant that hands out gapless numbers and moves the
   invoice from draft to finalized in the same operation, taken only after the totals validate, with
   a reconcile path against the issued invoices.
3. A **gRPC** tax client: a 2-second deadline per quote, a bounded retry of the transient statuses
   only, a jurisdiction rejection that is terminal and names the jurisdiction, and a **hold** — the
   invoice stays a draft with a retry marker — when the answer is unknown.
4. A **Kafka** lifecycle: \`invoice.event\` keyed by invoice id with idempotent, \`acks=all\`
   publishes of created, finalized, sent and paid, carrying totals and per-line SHA-256 digests and
   no descriptions, published only after the number claim has committed.
5. \`GET /v1/invoices/{id}\`: one stored invoice, two server-side projections — the issuer's copy
   and the customer's copy with internal notes and cost margins removed — with drafts hidden from
   customers and a foreign invoice answered as **404**.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real billing
feature: read the draft against the failure modes, name the subtle one, fix it, and prove the fix
with checks that fail on the draft and pass on your version.

## Left out on purpose

Payment capture, credit notes and disputes, dunning and reminders, multi-currency FX, PDF rendering,
email delivery, credit-limit enforcement, tax-rule authoring, and the accounting ledger's own
schema. The five pieces above are the ones that decide whether an invoice service is correct,
auditable and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'issuer · customer', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Invoice Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'invoice store', sub: 'drafts · finals · history', x: 46, y: 22},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'seq:{tenant} · claims', x: 46, y: 62},
      {id: 'tax', kind: 'grpc', label: 'Tax service', sub: 'Quote / Reject', x: 68, y: 10},
      {id: 'kafka', kind: 'kafka', label: 'invoice.event', sub: 'key = invoice id', x: 46, y: 92},
      {id: 'consumer', kind: 'service', label: 'Ledger consumer', sub: 'group ledger', x: 68, y: 74},
      {id: 'auditor', kind: 'external', label: 'Auditor', sub: 'history · exports', x: 68, y: 44},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS · X-Tenant-Id'},
      {from: 'api', to: 'db', kind: 'plain', label: 'invoice rows'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'claim · sequence'},
      {from: 'api', to: 'tax', kind: 'grpc', label: 'Quote / Reject'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce invoice.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'ledger rows'},
      {from: 'auditor', to: 'api', kind: 'http', label: 'GET /v1/invoices/{id}'},
    ],
  },
  steps: [invoiceEndpointStep, invoiceStateStep, invoiceDependencyStep, invoiceEventsStep, invoiceReadStep],
};
