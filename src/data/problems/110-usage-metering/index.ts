import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Usage metering on the AI-era track: the course is not "increment a counter per request", it is the
 * review you owe a model-generated metering layer before an invoice depends on it. Validated,
 * request-id-deduped reports → one atomic Redis window per account with the cap written as an
 * overage flag → a deadline-bounded, idempotent billing close keyed by a derived close id → account-
 * keyed rollup events with no request content → a tenant-scoped read that ties out with the same
 * counters.
 */
export const usageMeteringProblem: Problem = {
  id: 'usage-metering',
  title: 'Usage Metering',
  tagline: 'API usage counted once per request, capped by plan and reconciled with billing.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Usage Metering

Usage metering is the piece of a platform that turns "a request happened" into "this account used this
much of its plan", and then hands that number to billing. The visible part is a number on an invoice;
the parts that decide whether the number is right are the dedupe in front of the counter, the atomicity
of the window, the idempotency of the close, and the authorization on the read.

## The real system

Production metering sits on the hot path of every API call, but it is not allowed to be on the
critical path of correctness for the request itself. A retrying gateway re-sends the same report
several times; the meter counts the *request id* once. A plan has a cap per hour; the meter writes an
overage flag and never refuses traffic, because a metering outage must not become an availability
outage. The counters live per account per hour, incremented atomically with their expiry so a crash
between "answer the caller" and "increment the counter" cannot lose the last minute of usage. Billing
is closed per (account, period) under a close id derived from the period, so a retry after a timeout
carries the same id and billing can dedupe — a close id minted per attempt is a double bill. Analytics
receives rollup events keyed by the account so an account's usage stays ordered, carrying counters and
cap state but never request payloads or endpoint arguments. And the read returns the number the meter
is enforcing, with the cap state and the last reconciled close id, to the account it belongs to and to
nobody else.

## What you build here

One service, **meterd**, with five pieces:

1. \`POST /v1/usage\`: a validated report — request id, account, route and units — deduped by request
   id, capped per request, and stored with the reporting gateway so it can be reconciled.
2. A **Redis** window layer: \`usage:{account}:{hour}\`, incremented and expired by one atomic Lua
   script that also writes the usage record and the overage flag, and never blocks.
3. A **gRPC** billing client: a five-second deadline on \`ClosePeriod\`, a close id derived from the
   period, a timeout that leaves the period open, and a reply reconciled against the Redis counters.
4. A **Kafka** \`usage.rollup\` topic: events keyed by account, carrying the period, the units and the
   cap state, published only after the counters commit.
5. \`GET /v1/accounts/{account}/usage\`: the current window's units with cap state, overage and the
   last reconciled close id, authorized against the authenticated caller.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real metering
feature: read the draft against the failure modes, name the subtle one, fix it, and prove the fix with
checks that fail on the draft and pass on your version.

## Left out on purpose

Plan and pricing management, invoice rendering, tax, multi-currency, gateway fleet management, the
tokenizer that decides what a "unit" means per provider, and the historical warehouse. The five pieces
above are the ones that decide whether the number is counted once, capped honestly, closed idempotently
and read by the right caller.`,
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
