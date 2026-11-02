import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Returns processing: measured eligibility, atomic returnable quantities, inspection that gates
 * refunds, events keyed by return, and a read that reports a refund only once the processor
 * confirmed it.
 */
export const returnsProcessingProblem: Problem = {
  id: 'returns-processing',
  title: 'Returns Processing',
  tagline: 'Return requests measured against the policy window and graded at the warehouse before any refund leaves.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Returns Processing

Returns processing is the part of a commerce platform that decides whether a customer may send
something back, counts what is left to return on each line, sends the item to a warehouse to be
graded, pays the refund only once that grade arrives, and keeps the whole history ordered so support
can answer "where is my refund?" with a timeline instead of a guess. The visible part is a refund
amount; the parts that decide whether the platform is safe are the measured eligibility, the atomic
quantity, the gated refund and the ordered event log.

## The real system

Shopify's Admin GraphQL API models exactly this boundary. Before an app creates a \`Return\` with
\`returnCreate\`, it queries a \`ReturnableFulfillment\`: a delivered order whose line items carry
the quantity still available for return, computed by the platform from fulfilled and already
returned units rather than supplied by the caller. The same shape applies here: eligibility comes
from the delivery date and the policy window, the returnable quantity per line is decremented
atomically so two returns cannot both take the last unit, the warehouse grades the item under a
deadline and the refund is held while the grade is unknown, one event per state change is keyed by
the return so its history stays ordered, and a pending refund is not read as complete, because "we
started a refund" and "the customer was paid" are different facts.

## What you build here

One service, **returnsd**, with five pieces:

1. \`POST /v1/returns\`: validated order line, quantity, reason code and photo reference, with
   eligibility computed from the line's delivered date and policy window, quantities capped by what
   remains returnable, and body-supplied eligibility flags ignored.
2. A **Redis** returnable quantity: the decrement and the return registration happen in one atomic
   Lua script, a cancel restores exactly what its return consumed, and restoring twice restores once.
3. A **gRPC** warehouse inspection client: a 3-second deadline per grade, a timeout that holds the
   refund in \`awaiting-inspection\`, a \`damaged\` grade that reduces the refund per policy, and no
   retry for a grade that is terminal.
4. A **Kafka** event path: \`returns.event\` keyed by return id, short-lived evidence references or
   none, an outbox row when the broker rejects the produce, and refund state written before the
   offset is committed.
5. \`GET /v1/returns/{id}\`: the return's state, grade, refund linkage and original order line,
   scoped to the order's owner, where \`refunded\` means the processor confirmed it.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step you debug it against the failure modes, find the subtle one, fix it,
optimize what is wasteful, and prove the fix with checks that fail on the starter and pass on your
version.

## Left out on purpose

Payment rail integration, carrier label generation, restocking and resale, tax handling on refunds,
reason-code taxonomies per region, customer messaging, and returns analytics. The five pieces above
are the ones that decide whether returns are counted correctly, refunds are gated, and the history is
trustworthy.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Customer', sub: 'returns · tracking', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Returns API', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'db', kind: 'db', label: 'orders · returns', sub: 'lines · refunds', x: 52, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'returnable qty', x: 52, y: 42},
      {id: 'kafka', kind: 'kafka', label: 'returns.event', sub: 'key = return id', x: 52, y: 74},
      {id: 'warehouse', kind: 'grpc', label: 'Warehouse', sub: 'GradeItem', x: 76, y: 12},
      {id: 'refunds', kind: 'service', label: 'Refund processor', sub: 'async settle', x: 76, y: 46},
      {id: 'consumer', kind: 'service', label: 'Returns consumer', sub: 'group history', x: 76, y: 80},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'lines · refunds'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'returnable qty'},
      {from: 'api', to: 'warehouse', kind: 'grpc', label: 'GradeItem'},
      {from: 'api', to: 'refunds', kind: 'plain', label: 'issue refund'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce returns.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'persist state'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'restore qty on cancel'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
