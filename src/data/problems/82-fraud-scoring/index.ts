import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Fraud scoring: the debugging you owe a scoring service before it decides who gets approved.
 * Server-derived features and an account check with a transaction dedupe → one atomic Redis
 * velocity window per card and device → a model call with a 300 ms deadline and a bounded rules
 * fallback instead of a zero → account-keyed score events that carry a feature digest and move the
 * alerting counters before the offset commit → a case read that masks the account's card data and
 * scopes every lookup to the caller's tenant.
 */
export const fraudScoringProblem: Problem = {
  id: 'fraud-scoring',
  title: 'Fraud Scoring',
  tagline: 'Score card transactions with Redis velocity windows, a rules fallback and masked case reads.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Fraud Scoring

A fraud scorer decides, in a few dozen milliseconds, whether a transaction is approved, declined or
sent to review.

## The real system

Stripe Radar is the documented version of this shape. Its rules are \`{action} if {condition}\`
predicates (\`Block if :amount_in_usd: > 1000.00\`) evaluated in a fixed order, request-3DS, allow,
block, review, and the velocity attributes they read, such as \`total_charges_per_customer_hourly\`,
are windowed counts maintained by Stripe over previous attempts, so the entity being scored cannot
supply its own count. Payments placed in review go to a queue where a human sees the outcome, not
the raw card. This course builds the same bones: server-derived features, velocity counted before
the model is asked, a rules fallback when the model is unreachable, and masked case details.

## What you build here

One service, **scorer**, with five pieces:

1. \`POST /v1/scores\`: an account that must exist (**404** before any model work), server-derived
   features (\`derive_features\` at a pinned \`FEATURE_VERSION\`) and a \`transaction_id\` dedupe key so
   a retry returns the stored score instead of scoring twice.
2. A **Redis** velocity store: attempts per card per hour and distinct accounts per device per day,
   written by one atomic Lua \`EVAL\` at score time, with the window keys expiring on their own
   boundary and one shared rule set behind reads and alerting.
3. A **gRPC** model client: a 300 ms deadline per attempt, at most three attempts, retries only on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, a terminal \`INVALID_ARGUMENT\`, and a deterministic rules
   fallback clamped to the rules band and marked as a fallback.
4. A **Kafka** score path: one \`fraud.scored\` event per decision keyed by account reference, an
   idempotent \`acks=all\` producer, a payload with the band, the fallback marker and a feature
   digest, and a consumer that updates counters before it commits the offset.
5. \`GET /v1/cases/{id}\`: score, signals, velocity snapshot and masked card references, a **404**
   for a case that belongs to another tenant, and raw card data only through a separately audited
   tool.

## The debugging habit

Every starter compiles, serves the happy path and hides flaws. Debug it against the failure modes,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Feature engineering and model training, rules authoring, chargeback feedback, the analyst queue,
multi-region scoring and card vault key management.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Merchant client', sub: 'POST /v1/scores', x: 8, y: 40},
      {id: 'scorer', kind: 'http', label: 'Fraud Scorer', sub: 'HTTPS :8443', x: 30, y: 56},
      {id: 'accounts', kind: 'db', label: 'Accounts · cases', sub: 'known accounts · cards', x: 52, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'velocity · dedupe', x: 52, y: 42},
      {id: 'kafka', kind: 'kafka', label: 'fraud.scored', sub: 'key = account', x: 52, y: 72},
      {id: 'model', kind: 'grpc', label: 'Fraud model', sub: 'Score · 300 ms', x: 74, y: 8},
      {id: 'rules', kind: 'service', label: 'Rules engine', sub: 'fallback band', x: 74, y: 30},
      {id: 'consumer', kind: 'service', label: 'Alerting consumer', sub: 'group alerts', x: 74, y: 52},
      {id: 'reviewer', kind: 'client', label: 'Review console', sub: 'GET /v1/cases/{id}', x: 8, y: 78},
      {id: 'audit', kind: 'external', label: 'Audit tool', sub: 'raw card · audited', x: 74, y: 74},
    ],
    edges: [
      {from: 'client', to: 'scorer', kind: 'http', label: 'POST /v1/scores'},
      {from: 'scorer', to: 'accounts', kind: 'plain', label: 'account · case lookup'},
      {from: 'scorer', to: 'redis', kind: 'redis', label: 'EVAL velocity'},
      {from: 'scorer', to: 'model', kind: 'grpc', label: 'Score · 300 ms'},
      {from: 'scorer', to: 'rules', kind: 'plain', label: 'on timeout'},
      {from: 'scorer', to: 'kafka', kind: 'kafka', label: 'produce fraud.scored'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY before commit'},
      {from: 'reviewer', to: 'scorer', kind: 'http', label: 'GET /v1/cases/{id}'},
      {from: 'audit', to: 'accounts', kind: 'plain', label: 'audited PAN read'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
