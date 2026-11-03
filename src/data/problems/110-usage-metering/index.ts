import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Usage metering: the course is not "increment a counter per request", it is the debugging you owe
 * a metering layer before an invoice depends on it. Validated, request-id-deduped reports → one
 * atomic Redis window per account with the cap written as an overage flag → a deadline-bounded,
 * idempotent billing close keyed by a derived close id → account-keyed rollup events with no
 * request content → a tenant-scoped read that ties out with the same counters.
 */
export const usageMeteringProblem: Problem = {
  id: 'usage-metering',
  title: 'Usage Metering',
  tagline: 'API usage counted once per request id, flagged at the plan cap, closed to billing under one id.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Usage Metering

Usage metering is the piece of a platform that turns "a request happened" into "this account used this
much of its plan", and then hands that number to billing. The visible part is a number on an invoice;
the parts that decide whether the number is right are the dedupe in front of the counter, the atomicity
of the window, the idempotency of the close, and the authorization on the read.

## The real system

OpenMeter, the open-source metering service behind Kong's metering and billing product, ingests
usage as CloudEvents and deduplicates them by \`id\` plus \`source\`: a producer that retries after a
network error re-sends the same id, and the meter processes it once. Aggregation is by \`subject\`,
the customer, over fixed time windows, which is the same shape this course asks for with
\`(account, request_id)\` as the dedupe key and \`usage:{account}:{hour}\` as the window. The rest of
the shape follows from where the number ends up: metering sits on the hot path of every API call but
must not gate it, so past the plan cap the meter writes an overage flag and keeps counting, and a
billing close carries an id derived from the period so a retry cannot double bill.

## What you build here

One service, **meterd**, with five pieces:

1. \`POST /v1/usage\`: a validated report, with request id, account, route and units, deduped by
   request id, capped per request, and stored with the reporting gateway so it can be reconciled.
2. A **Redis** window layer: \`usage:{account}:{hour}\`, incremented and expired by one atomic Lua
   script that also writes the usage record and the overage flag, and does not block.
3. A **gRPC** billing client: a five-second deadline on \`ClosePeriod\`, a close id derived from the
   period, a timeout that leaves the period open, and a reply reconciled against the Redis counters.
4. A **Kafka** \`usage.rollup\` topic: events keyed by account, carrying the period, the units and the
   cap state, published only after the counters commit.
5. \`GET /v1/accounts/{account}/usage\`: the current window's units with cap state, overage and the
   last reconciled close id, authorized against the authenticated caller.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. Debug
it against the failure modes, fix it, and prove the fix with checks that fail on the starter.

## Left out on purpose

Plan and pricing management, invoice rendering, tax, gateway fleet management, per-provider unit
definitions, and the historical warehouse.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Gateway', sub: 'report · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Metering API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'coverage', kind: 'service', label: 'Plan coverage', sub: 'cap · overage', x: 26, y: 12},
      {id: 'store', kind: 'db', label: 'Usage records', sub: 'records · close ids', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'windowed counters', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'usage.rollup', sub: 'key = account', x: 46, y: 86},
      {id: 'engine', kind: 'grpc', label: 'Billing service', sub: 'ClosePeriod', x: 68, y: 12},
      {id: 'fallback', kind: 'external', label: 'Gateway logs', sub: 'reconcile', x: 68, y: 62},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/usage'},
      {from: 'client', to: 'api', kind: 'http', label: 'GET usage'},
      {from: 'api', to: 'coverage', kind: 'plain', label: 'cap · overage'},
      {from: 'api', to: 'store', kind: 'plain', label: 'record{gateway}'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'apply_usage'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce usage.rollup'},
      {from: 'redis', to: 'engine', kind: 'grpc', label: 'ClosePeriod'},
      {from: 'engine', to: 'fallback', kind: 'plain', label: 'reconcile total'},
      {from: 'fallback', to: 'store', kind: 'plain', label: 'gateway logs'},
      {from: 'coverage', to: 'redis', kind: 'redis', label: 'cap state'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
