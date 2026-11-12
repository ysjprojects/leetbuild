import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {invoiceEndpointStep} from './steps/1-endpoint';
import {invoiceStateStep} from './steps/2-state';
import {invoiceDependencyStep} from './steps/3-dependency';
import {invoiceEventsStep} from './steps/4-events';
import {invoiceReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Invoice service: the course is not "POST an invoice and store it", it is the debugging you owe a
 * billing service before it issues a document a business is taxed on. Drafts stay editable and a
 * finalize replays → one Redis script claims a per-tenant number → tax is quoted under a deadline
 * and an unsure answer holds the draft → lifecycle events are keyed by invoice with line digests →
 * the read serves the issuer's copy and the customer's copy from one stored invoice.
 */
export const invoiceServiceProblem: Problem = {
  id: 'invoice-service',
  title: 'Invoice Service',
  tagline: 'Per-tenant gapless invoice numbers, claimed in Redis only once the tax quote is in.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Invoice Service

An invoice is the document a business is taxed on and paid against, so an invoice service is mostly
about promises that hold later: a number is issued once and in sequence, tax is settled before the
document exists, and an issued document stays as it was for the customer, the auditor and every
service that consumed its events.

## The real system

Stripe Invoicing draws the same line. An invoice is created as a draft, and draft invoices are fully
editable; finalizing one records the moment in \`status_transitions.finalized_at\`, and from then on
its monetary values can no longer be edited, so a correction is a credit note rather than an
update. This course builds that boundary inside one service: a finalize that a retry replays, a
number claimed atomically per tenant, a tax quote that holds the draft when it is unsure, lifecycle
events that carry digests instead of the customer's words, and a read that serves the issuer and the
customer different copies of one stored invoice.

## What you build here

One service, **invoiced**, on one invoice store (\`invoice.store\`, provided: an invoice is the Redis
hash \`invoice:{id}\`) and one finalize claim (\`claim_number\`, built in step 2 and provided to the
other steps as \`invoice.sequence\`):

1. \`POST /v1/invoices\`, \`PATCH /v1/invoices/{id}\`, \`POST /v1/invoices/{id}/finalize\`: validated
   currency and line items, **409** for an edit of a finalized invoice, **422** for an empty one, and
   an \`Idempotency-Key\` that replays a finalize.
2. A **Redis** claim: one Lua script that refuses a non-draft, \`INCR\`s \`invoice:seq:{tenant}\` and
   writes the number, run only after the totals validate.
3. A **gRPC** tax quote (\`Tax.Quote\`): a 2-second deadline, three attempts on transient statuses, a
   terminal jurisdiction refusal, and a hold when no quote arrives.
4. A **Kafka** \`invoice.event\` stream keyed by invoice id, carrying amounts and per-line SHA-256
   digests, produced after the claim, with refused deliveries kept in an outbox.
5. \`GET /v1/invoices/{id}\`: the role from \`X-Role\`, a customer projection, drafts hidden from
   customers, and another tenant's invoice answered as **404**.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Payment capture, credit notes and disputes, dunning, multi-currency FX, PDF rendering, email
delivery, tax-rule authoring, and the ledger's own schema.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'issuer · customer', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Invoice Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'invoice store', sub: 'invoice:{id} · outbox', x: 46, y: 22},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'invoice:seq:{tenant} · claim script', x: 46, y: 62},
      {id: 'tax', kind: 'grpc', label: 'Tax service', sub: 'Tax.Quote', x: 68, y: 10},
      {id: 'kafka', kind: 'kafka', label: 'invoice.event', sub: 'key = invoice id', x: 46, y: 92},
      {id: 'consumer', kind: 'service', label: 'Ledger consumer', sub: 'group ledger', x: 68, y: 74},
      {id: 'auditor', kind: 'external', label: 'Customer portal', sub: 'X-Role: customer', x: 68, y: 44},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS · X-Tenant-Id'},
      {from: 'api', to: 'db', kind: 'plain', label: 'invoice:{id}'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL claim'},
      {from: 'api', to: 'tax', kind: 'grpc', label: 'Quote · 2 s deadline'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce invoice.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'ledger rows'},
      {from: 'auditor', to: 'api', kind: 'http', label: 'GET /v1/invoices/{id}'},
    ],
  },
  steps: [invoiceEndpointStep, invoiceStateStep, invoiceDependencyStep, invoiceEventsStep, invoiceReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
