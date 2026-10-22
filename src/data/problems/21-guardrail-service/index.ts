import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Guardrail service on the AI-era track: the course is not "call a classifier", it is the review
 * you owe a model-generated safety gate before it decides what reaches a model. A pre-model check
 * endpoint that reads its rules from server-side config → a Redis policy cache and hourly violation
 * counters moved by one script → a classifier call with a deadline that fails safe for high-risk
 * tenants → violation events keyed by tenant, carrying spans and a fingerprint instead of the text,
 * with an outbox for rejected produces → a versioned, paged policy read that reviewers can trust.
 */
export const guardrailServiceProblem: Problem = {
  id: 'guardrail-service',
  title: 'Guardrail Service',
  tagline: 'Pre- and post-model checks that fail safe, count violations and never leak the prompt.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Guardrail Service

A guardrail service is the piece of an AI platform that stands between a user's prompt and the model,
and between the model's output and the user. It is the one service whose failure mode is invisible:
when it works nobody notices, and when it fails open every request is allowed and the dashboards stay
green. The visible part is a verdict — \`allow\`, \`block\` or \`review\` — but the parts that decide
whether the gate can be trusted are where the rules come from, how the counts are kept, what happens
when the classifier is down, what leaves the service in an event, and what a reviewer can read back.

## The real system

Production guardrails run as a sidecar to every model call. They evaluate input and output text
against a per-tenant rule set that lives in versioned configuration, never in the request, so a
caller cannot disable the rules that apply to it. They cache the compiled rule set in Redis so the hot
path stays cheap, and they count blocks per tenant per hour so an operator can see an attack before a
reviewer can. They call a classifier under a deadline and, when it does not answer, they fall back to
a conservative verdict for tenants whose traffic is risky and a permissive one for the rest. They
publish violation events keyed by tenant so a review queue stays ordered, and those events carry span
offsets and a fingerprint rather than the offending text, because a retained topic is the worst place
to discover you copied a customer's prompt. And they expose the active policy with a version and a
promotion time, so a reviewer, an auditor and a rollback can all agree on what was live when.

## What you build here

One service, **guardraild**, with five pieces:

1. \`POST /v1/guardrails/check\`: the pre-model gate. The tenant is authenticated, \`direction\` is
   \`input\` or \`output\` (**400** for anything else), the text is capped at 64 KiB, and the verdict
   comes from the **server-side** rule set — the rule ids that fired are returned, and a block
   response returns rule ids and spans rather than the offending text.
2. A **Redis** policy cache: one atomic \`SET\` of a fully compiled rule set per tenant, and a
   violation counter for the current hour window moved by a single Lua \`EVAL\` that also sets the
   expiry, so concurrent blocks lose no count and the key resets hourly.
3. A **gRPC** classifier client: a 300 ms deadline per attempt, no retry for a deterministic
   \`INVALID_ARGUMENT\`, a breaker after repeated failures, and a conservative **deny** for high-risk
   tenants while everyone else keeps their configured fallback.
4. A **Kafka** violation path: one \`guardrail.violation\` event per block keyed by tenant, carrying
   the rule ids and span offsets plus a salted fingerprint, with no raw text, and an outbox row when
   the broker rejects the produce so review never loses a block.
5. \`GET /v1/guardrails/policies\`: the contract reviewers read. A version that was never promoted is
   **404**, the rule set is capped and paged (\`MAX_PAGE_SIZE = 200\`), and a promotion is visible on
   the very next read because the cache is keyed by version, expires, and is dropped on promotion.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version. The subtle ones here are the rule set that arrives
from the caller, the counter that loses a concurrent block, the deterministic rejection that gets
retried four times, the event key that scatters one tenant across partitions, and the version
parameter that is copied instead of resolved.

## Left out on purpose

Rule authoring UIs, classifier training and evaluation, prompt-injection detection models, human
review workflows and queues, per-region rule replication, billing for classifier calls, and the
appeals process. The five pieces above are the ones that decide whether the gate fails safe, counts
honestly, leaks nothing and can be reviewed.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Caller', sub: 'check · policies', x: 8, y: 50},
      {id: 'guardrail', kind: 'http', label: 'Guardrail Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'policy store', sub: 'rules · versions', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'policy cache · counters', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'guardrail.violation', sub: 'key = tenant', x: 44, y: 86},
      {id: 'classifier', kind: 'grpc', label: 'Classifier', sub: 'Classify · 300 ms', x: 66, y: 12},
      {id: 'fallback', kind: 'external', label: 'Fail-safe verdict', sub: 'conservative deny', x: 66, y: 38},
      {id: 'review', kind: 'service', label: 'Review worker', sub: 'ordered queue', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'guardrail', kind: 'http', label: 'POST /check'},
      {from: 'guardrail', to: 'db', kind: 'plain', label: 'rules · versions'},
      {from: 'guardrail', to: 'redis', kind: 'redis', label: 'cache · counters'},
      {from: 'guardrail', to: 'classifier', kind: 'grpc', label: 'Classify · 300 ms'},
      {from: 'guardrail', to: 'fallback', kind: 'plain', label: 'on timeout'},
      {from: 'guardrail', to: 'kafka', kind: 'kafka', label: 'produce violation'},
      {from: 'kafka', to: 'review', kind: 'kafka', label: 'consume'},
      {from: 'review', to: 'redis', kind: 'redis', label: 'review counters'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
