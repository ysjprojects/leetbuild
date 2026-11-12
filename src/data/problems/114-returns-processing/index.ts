import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Returns processing: eligibility measured against the line's policy window → returnable units
 * taken and the return recorded in one Lua script → a warehouse grade under a deadline before any
 * refund → return-keyed events with an outbox → a read where `refunded` means the processor
 * confirmed it.
 */
export const returnsProcessingProblem: Problem = {
  id: 'returns-processing',
  title: 'Returns Processing',
  tagline: 'Return windows, returnable units in Lua, warehouse grades before refunds, and a timeline keyed by return.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Returns Processing

Returns processing decides whether a customer may send something back, counts what is left to
return on each order line, has the warehouse grade the item, pays a refund only once that grade
arrives, and keeps the history ordered so support can answer "where is my refund?" from records
rather than guesses.

## The real system

Shopify's Admin GraphQL API exposes a \`ReturnableFulfillment\`: a delivered order that is eligible
to be returned, whose \`ReturnableFulfillmentLineItem\`s carry the \`quantity\` still returnable. The
platform computes that number from what was fulfilled and already returned; an app creating a
return reads it rather than asserting it. This course builds the same boundary.

## What you build here

One service, **returnsd**, over one store (\`returns.store\`, provided): \`order_line:{id}\`,
\`return:{id}\` and \`refund:{id}\` hashes, the \`outbox\` list, and \`today\`/\`add_days\` on UTC
days. The returnable units of a line live in \`line:{id}:returnable\`, owned by
\`register_return\`/\`cancel_return\` (built in step 2, provided to the other steps as
\`returns.ledger\`).

1. \`POST /v1/returns\` with \`X-Tenant-Id\` and \`{order_line_id, quantity, reason_code,
   photo_ref}\`: the window is the line's \`policy_window\` (30 or 60 days after \`delivered_at\`),
   the reason code and its evidence are checked, and the units go through \`register_return\`.
2. **Redis**: \`register_return\` checks, decrements and writes the record in one Lua script;
   \`cancel_return\` gives back the return's own quantity, once.
3. **gRPC** \`settle_return(return_id)\`: \`Warehouse.GradeItem\` under a 3-second deadline, then
   \`Refunds.IssueRefund\` for the amount the grade allows; no grade holds the return in
   \`awaiting_inspection\`.
4. **Kafka** \`record_transition(ret, state)\`: the state is written, then \`returns.event\` is
   produced keyed by return id, with an outbox row when the broker does not acknowledge.
5. \`GET /v1/returns/{id}\`: the return, its refund and its order line, scoped to the tenant, where
   \`refunded\` means the processor confirmed the refund.

\`\`\`proto
service Warehouse { rpc GradeItem(GradeRequest) returns (GradeReply); }       // grade: sellable | damaged
service Refunds   { rpc IssueRefund(RefundRequest) returns (RefundReply); }   // refund_id, state: initiated
\`\`\`

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Payment rails, carrier labels, restocking, tax on refunds, regional reason codes, customer
messaging and returns analytics.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Customer', sub: 'return · track', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'returnsd', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'db', kind: 'db', label: 'returns store', sub: 'order_line · return · refund', x: 52, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'line:{id}:returnable', x: 52, y: 42},
      {id: 'kafka', kind: 'kafka', label: 'returns.event', sub: 'key = return id', x: 52, y: 76},
      {id: 'warehouse', kind: 'grpc', label: 'Warehouse', sub: 'GradeItem · 3 s', x: 78, y: 12},
      {id: 'refunds', kind: 'grpc', label: 'Refund processor', sub: 'IssueRefund', x: 78, y: 44},
      {id: 'consumer', kind: 'service', label: 'Support timeline', sub: 'consumes returns.event', x: 78, y: 78},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'line_of · return_of · refund_of'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'register_return · cancel_return'},
      {from: 'api', to: 'warehouse', kind: 'grpc', label: 'GradeItem'},
      {from: 'api', to: 'refunds', kind: 'grpc', label: 'IssueRefund'},
      {from: 'refunds', to: 'db', kind: 'plain', label: 'refund confirmed · failed'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the state write'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
