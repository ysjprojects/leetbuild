import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {propagateDeadlineStep} from './steps/1-propagate-deadline';

/**
 * Drill: a gRPC server that prices a quote by calling a downstream service inside its caller's
 * deadline, minus a reserve, and never past it.
 */
export const grpcDeadlinePropagationProblem: Problem = {
  id: 'grpc-deadline-propagation',
  title: 'gRPC deadline propagation',
  tagline:
    "A server that spends its caller's deadline, not its own: remaining time minus a 50 ms reserve downstream, DEADLINE_EXCEEDED when nothing is left, one call, mapped statuses.",
  difficulty: 'medium',
  concepts: ['grpc'],
  minutes: 25,
  statement: `# gRPC deadline propagation

A deadline is the instant after which a caller no longer wants the answer. A server in the middle of a
call chain does not own it: it reads how much is left, keeps a little back to answer with, and passes the
rest to its own downstream calls. Without that, each hop sets its own timeout and keeps working, and
retrying, long after the user has seen an error. Google's SRE guidance names deadline propagation as a
first defence against cascading failure; Go's \`context\`, grpc-java's \`Context\` and the \`grpc-timeout\`
header exist to carry it.

Here \`Quotes.GetQuote\` (package \`quotes.v1\`) prices a line item by calling \`Pricing.GetPrice\` at
\`pricing:50051\`. \`QuoteRequest{sku, qty}\` → \`Quote{sku, qty, total_cents}\`, \`PriceRequest{sku}\` →
\`Price{unit_cents}\`. Constants: \`DEFAULT_BUDGET = 1.0\` s for a caller that sent no deadline, \`RESERVE =
0.05\` s. Statuses: \`INVALID_ARGUMENT\` for an empty sku or \`qty <= 0\`, \`DEADLINE_EXCEEDED\` when
\`budget - RESERVE <= 0\`, and pricing's \`DEADLINE_EXCEEDED\`, \`NOT_FOUND\` and \`UNAVAILABLE\` passed through,
anything else \`INTERNAL\`.

## What you build here

1. \`GetQuote\`: validate, compute the budget from the incoming deadline, refuse a spent one, call
   \`GetPrice\` once with \`budget - RESERVE\`, map its status, and return \`unit_cents * qty\`.

## Left out on purpose

Propagating cancellation (stopping pricing when the caller hangs up), retries and hedging at the hop that
owns the deadline, per-hop reserves sized from latency percentiles, and load shedding when the budget
left is below a dependency's p99.`,
  diagram: {
    nodes: [
      {id: 'checkout', kind: 'client', label: 'Checkout', sub: 'GetQuote · deadline 0.8 s', x: 10, y: 50},
      {id: 'quotes', kind: 'service', label: 'Quotes', sub: 'budget = time left · minus RESERVE', x: 45, y: 50},
      {id: 'pricing', kind: 'grpc', label: 'Pricing', sub: 'pricing:50051 · GetPrice', x: 80, y: 50},
    ],
    edges: [
      {from: 'checkout', to: 'quotes', kind: 'grpc', label: 'GetQuote{sku, qty}'},
      {from: 'quotes', to: 'pricing', kind: 'grpc', label: 'GetPrice{sku} · timeout budget - RESERVE'},
    ],
  },
  support: {python: protoModules, typescript: protoFiles, go: protoFiles, cpp: protoFiles},
  steps: [propagateDeadlineStep],
  learn,
};
