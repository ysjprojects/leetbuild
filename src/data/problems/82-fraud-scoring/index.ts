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

A fraud scorer is the piece of a payments platform that decides, in a few dozen milliseconds, whether
a transaction is approved, declined or sent to review. The visible part is a risk number; the parts
that decide whether the platform is safe are the trust boundary around the feature vector, the
velocity counters that make a burst visible, the failure policy when the model is unreachable, and
what the review console is allowed to see.

## The real system

Stripe Radar is the documented version of this shape. Its rules are \`{action} if {condition}\`
predicates (\`Block if :amount_in_usd: > 1000.00\`) evaluated in a fixed order, request-3DS, allow,
block, review, and the velocity attributes they read, such as \`total_charges_per_customer_hourly\`,
are windowed counts maintained by Stripe over previous attempts, so the entity being scored cannot
supply its own count. Some of those counters are bounded: once the cap is reached the oldest
timestamps fall out and newer ones replace them. The decision lands in one of a small set of bands,
and payments placed in review go to a queue where a human sees the outcome, not the raw card.

This course builds the same bones in one service. Features are derived server-side so the request
cannot carry its own risk. Every attempt is counted in Redis before the model is asked anything,
because a declined attempt is the signal a fraud ring produces when it retries, and the windows are
keyed by card, device and bucket so they reset on time. The model is called over gRPC under a
deadline; when it is unreachable the service degrades to a deterministic rules score inside a
configured band and marks the verdict as a fallback. Outcomes go to a retained topic keyed by
account, carrying a digest rather than the feature vector, and the alerting consumer moves its
counters before it commits an offset. A case detail shows masked identifiers; raw card data lives
behind one separately audited tool.

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

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is to debug it against the failure modes, fix it, optimize
what is wasteful, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Feature engineering and model training, the rules authoring UI, chargeback feedback loops, the
analyst queue, multi-region scoring, key management for the card vault, and the audit warehouse. The
five pieces above are the ones that decide whether the scorer is trustworthy, degradable and
shippable.`,
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
