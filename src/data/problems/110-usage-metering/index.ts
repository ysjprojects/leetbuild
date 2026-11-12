import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Usage metering: the course is not "increment a counter per request", it is the debugging you owe
 * a metering layer before an invoice depends on it. Validated reports counted once per request id →
 * one atomic Redis script per report that flags overage instead of refusing → a billing close under
 * a derived close id, bounded by a deadline and reconciled against the counters → account-keyed
 * rollup events produced after the count commits → an authorized read of the current window.
 */
export const usageMeteringProblem: Problem = {
  id: 'usage-metering',
  title: 'Usage Metering',
  tagline:
    'API usage counted once per request id in an hourly Redis window, then closed to billing under a derived id.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Usage Metering

Usage metering turns "a request happened" into "this account used this much of its plan this hour"
and hands that number to billing. The number on the invoice is only as good as four things behind
it: the dedupe in front of the counter, the atomicity of the count, the idempotency of the close,
and the authorization on the read.

## The real system

OpenMeter, the open-source metering service, ingests usage as CloudEvents and deduplicates them by
\`id\` and \`source\`: a producer that retries after a network error re-sends the same id and the
meter counts it once. Meters aggregate by \`subject\` (the customer) over time windows. This course
builds the same shape with \`(account, request_id)\` as the dedupe key and an hourly Redis hash as
the window.

## What you build here

One service, **usaged**, on one ledger (\`metering.ledger\`, provided): the window hash
\`usage:{account}:{window}\` (\`units\`, \`cap\`, \`overage\`), the record
\`usage:record:{account}:{request_id}\`, the plan \`plan:{account}\` and the last close
\`close:{account}\`. A window is \`floor(unix seconds / 3600)\`; keys live two hours.

1. \`POST /v1/usage\` with \`{request_id, account, route, units}\` and \`X-Gateway-Id\`: validated,
   counted once per request id, stored with its gateway.
2. \`apply_usage\`: one **Redis** Lua script that dedupes, counts, flags overage past the plan cap
   and sets the expiry. Later steps import it as \`metering.usage\`.
3. \`close_period\`: the **gRPC** \`Billing.ClosePeriod\` call under the close id
   \`close:{account}:{window}\`, a 5-second deadline, and a reply reconciled against the window.
4. \`report_usage\`: \`apply_usage\`, then a **Kafka** \`usage.rollup\` event keyed by account with
   \`{account, window, units, total, over}\`.
5. \`GET /v1/accounts/{account}/usage\`: the current window, cap, overage and last close id, for
   the caller named by \`X-Account-Id\` only.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. In
every step, debug it against the failure modes the task names, fix it, and prove the fix with checks
that fail on the starter and pass on your version.

## Left out on purpose

Plan and pricing management, invoice rendering, tax, gateway fleet management, per-route unit
definitions and the historical warehouse.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Gateway', sub: 'report · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'usaged', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'store', kind: 'db', label: 'Usage ledger', sub: 'records · plan · close', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'usage:{account}:{window}', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'usage.rollup', sub: 'key = account', x: 46, y: 86},
      {id: 'engine', kind: 'grpc', label: 'Billing service', sub: 'ClosePeriod · 5 s', x: 68, y: 30},
      {id: 'analytics', kind: 'service', label: 'Rollup consumers', sub: 'analytics · alerts', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/usage'},
      {from: 'client', to: 'api', kind: 'http', label: 'GET usage'},
      {from: 'api', to: 'store', kind: 'plain', label: 'find_record · last_close'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'apply_usage'},
      {from: 'api', to: 'engine', kind: 'grpc', label: 'ClosePeriod(close:{account}:{window})'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the count'},
      {from: 'kafka', to: 'analytics', kind: 'kafka', label: 'consume'},
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
