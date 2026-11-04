import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Fraud scoring: the debugging a scoring service needs before it decides who gets approved.
 * Server-derived features, an account check and a transaction dedupe → one atomic Redis velocity
 * script per card and device → a model call with a 300 ms deadline and a rules fallback that never
 * approves → account-keyed score events with a feature digest and alerting counters moved before the
 * offset commit → a case read scoped to the caller's tenant that masks the card.
 */
export const fraudScoringProblem: Problem = {
  id: 'fraud-scoring',
  title: 'Fraud Scoring',
  tagline: 'Card velocity windows in Redis, a rules fallback for the fraud model, and masked review cases.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Fraud Scoring

A fraud scorer decides, in a few dozen milliseconds, whether a card transaction is approved, sent to
review or declined. Its inputs are the one thing an attacker would love to write, and its outage
mode decides whether an incident is about availability or about money.

## The real system

Stripe Radar is the documented version of this shape. Its rules read \`Block if
:total_charges_per_card_number_hourly: > 5\`: the velocity attribute is a count Stripe keeps over
previous attempts, so the card being scored cannot supply its own number. The model's score and
the rules run on server-side data, and payments placed in review reach a human who sees the
decision, not the raw card. This course builds the same bones.

## What you build here

One service, **scorer**, on a shared \`fraud\` package (provided): \`fraud.features\` (the vector
at \`FEATURE_VERSION\`, its digest, the bands and the rules engine), \`fraud.store\` (accounts,
decisions, review cases and the PAN audit log) and \`fraud.model\` (the step 3 client as the other
steps call it).

1. \`POST /v1/scores\` with \`{transaction_id, account_ref, amount_cents}\`: an unknown account is
   **404** before any model work, features come from \`derive_features\`, never from the caller, and
   a replayed \`transaction_id\` answers the stored decision.
2. A **Redis** velocity store: \`vel:card:{card_ref}\` (attempts, one-hour window) and
   \`vel:device:{device_id}\` (distinct accounts, one-day window), moved by one Lua script before the
   model is asked, with one \`VELOCITY_RULES\` table behind the snapshot and the alert.
3. A **gRPC** client for \`Model.Score\`: 300 ms per attempt, three attempts, only \`UNAVAILABLE\`
   and \`DEADLINE_EXCEEDED\` retried, \`INVALID_ARGUMENT\` terminal, and a rules verdict marked
   \`fallback\` that never lands in the approve band.
4. A **Kafka** \`fraud.scored\` stream keyed by account, carrying the band, the fallback marker and a
   feature digest, produced idempotently with \`acks=all\`, and an alerting consumer that moves
   \`alerts:{account_ref}\` before it commits.
5. \`GET /v1/cases/{id}\` for the review console: scoped to \`X-Tenant-Id\`, the card masked, raw card
   data only through an audited \`audited_pan\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Feature engineering and model training, rules authoring, chargeback feedback, the analyst queue and
card vault key management.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Merchant client', sub: 'POST /v1/scores', x: 8, y: 34},
      {id: 'scorer', kind: 'http', label: 'scorer', sub: 'HTTPS :8443', x: 30, y: 52},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'vel:card · vel:device · decisions · cases', x: 52, y: 30},
      {id: 'kafka', kind: 'kafka', label: 'fraud.scored', sub: 'key = account_ref', x: 52, y: 74},
      {id: 'model', kind: 'grpc', label: 'Fraud model', sub: 'Model.Score · 300 ms', x: 74, y: 10},
      {id: 'rules', kind: 'service', label: 'Rules engine', sub: 'fallback · never approve', x: 74, y: 34},
      {id: 'consumer', kind: 'service', label: 'Alerting consumer', sub: 'group alerting', x: 74, y: 62},
      {id: 'reviewer', kind: 'client', label: 'Review console', sub: 'GET /v1/cases/{id}', x: 8, y: 80},
      {id: 'audit', kind: 'external', label: 'Audit log', sub: 'audited_pan · pan:read', x: 74, y: 88},
    ],
    edges: [
      {from: 'client', to: 'scorer', kind: 'http', label: 'POST /v1/scores'},
      {from: 'scorer', to: 'redis', kind: 'redis', label: 'EVAL velocity · decision'},
      {from: 'scorer', to: 'model', kind: 'grpc', label: 'Score · 300 ms'},
      {from: 'scorer', to: 'rules', kind: 'plain', label: 'attempts exhausted'},
      {from: 'scorer', to: 'kafka', kind: 'kafka', label: 'produce fraud.scored'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY before commit'},
      {from: 'reviewer', to: 'scorer', kind: 'http', label: 'GET /v1/cases/{id}'},
      {from: 'scorer', to: 'audit', kind: 'plain', label: 'audited PAN read'},
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
