import type {Problem} from '@/lib/types';

import {invoiceEndpointStep} from './steps/1-endpoint';
import {invoiceStateStep} from './steps/2-state';
import {invoiceDependencyStep} from './steps/3-dependency';
import {invoiceEventsStep} from './steps/4-events';
import {invoiceReadStep} from './steps/5-read';

/**
 * Invoice service: the course is not "POST an invoice and store it", it is the debugging you owe a
 * billing service before it issues a document a business is taxed on. Drafts stay editable →
 * finalization takes a per-tenant number atomically → tax is quoted under
 * a deadline and an unsure answer holds the invoice → lifecycle events are keyed by invoice with
 * line digests → the read serves the issuer's copy and the customer's copy from one stored invoice.
 */
export const invoiceServiceProblem: Problem = {
  id: 'invoice-service',
  title: 'Invoice Service',
  tagline:
    'Invoices with a gapless per-tenant number, a tax quote before finalize and a document that is immutable once issued.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Invoice Service

An invoice is the one document a business is legally allowed to be chased for, so an invoice service
is about the promises it keeps: a number is issued once, tax is decided before the document exists,
and nothing about a finalized invoice changes again, not the line items, not the customer's view of
it, not the events another team already consumed.

## The real system

Stripe Invoicing draws the same line between a draft and an issued document. An invoice is created
as a \`draft\` that can be edited freely; \`POST /v1/invoices/{id}/finalize\` is a one-way
transition that assigns the invoice \`number\`, records \`status_transitions.finalized_at\` and
returns the invoice with \`status=open\`, after which the line items are fixed and a correction is a
credit note or a new revision. A finalize attempt can fail, and when it does the invoice keeps the
cause in \`last_finalization_error\` until a later attempt succeeds, rather than being issued with a
guess. This course keeps the same promises inside one service: a claim atomic with the finalize
transition, validation before the claim so a rejection burns nothing, a tax quote under a deadline
whose unknown answer holds the draft, lifecycle events keyed by invoice id with digests instead of
the customer's words, and a read that serves two copies from one stored invoice.

## What you build here

One service, **invoiced**, with five pieces:

1. \`POST /v1/invoices\`, \`PATCH /v1/invoices/{id}\` and \`POST /v1/invoices/{id}/finalize\`:
   validated line items and currency, an update a finalized invoice rejects with **409**, an empty
   invoice that cannot finalize, and a finalize that a retry replays.
2. A **Redis** sequence: one atomic claim per tenant that hands out gapless numbers and moves the
   invoice to finalized in the same operation, taken only after the totals validate.
3. A **gRPC** tax client: a 2-second deadline per quote, a bounded retry of the transient statuses
   only, a terminal jurisdiction rejection, and a hold when the answer is unknown.
4. A **Kafka** lifecycle: \`invoice.event\` keyed by invoice id, carrying totals and per-line SHA-256
   digests, published only after the number claim has committed.
5. \`GET /v1/invoices/{id}\`: one stored invoice, two server-side projections, drafts hidden from
   customers and a foreign invoice answered as **404**.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Payment capture, credit notes and disputes, dunning, multi-currency FX, PDF rendering, email
delivery, tax-rule authoring, and the accounting ledger's own schema.`,
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
