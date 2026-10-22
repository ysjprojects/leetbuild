import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Moderation service on the AI-era track: the course is not "call a classifier from an endpoint",
 * it is the review you owe a model-generated triage pipeline before it touches a real reporter.
 * A validated, per-reporter-unique report intake → an atomic Redis claim with a renewable lease →
 * a classifier call that may only auto-act on strong, corroborated evidence → content-keyed action
 * events with the reporter stripped and an outbox before the offset commit → a scoped case file
 * that redacts the reporter and escapes the free text.
 */
export const moderationServiceProblem: Problem = {
  id: 'moderation-service',
  title: 'Moderation Service',
  tagline: 'Auto-triage reports to a human queue with atomic claims and reporter-safe records.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Moderation Service

A moderation service is the piece of a product that turns a user's report into a decision someone
can stand behind: whether the content is real and belongs to the tenant that reported it, who is
reviewing it right now, whether a model is allowed to act on its own, what the platform records
about the action, and who may ever see the reporter. The visible part is a status on a case; the
parts that decide whether the platform is safe are the validation funnel, the claim that cannot be
double-held, the evidence bar in front of an automatic removal, and the redaction on every read.

## The real system

Production moderation pipelines receive reports from many tenants, prove that the reported content
is actually theirs, and fold a reporter's repeated reports on one item into the case that already
exists instead of minting a new one. They hand items to human moderators through a queue that is
claimed atomically and leased, so an item a crashed reviewer was holding comes back to the queue
instead of being stranded. They call a classifier under a tight deadline and treat it as advice,
not authority: an automatic action requires a very high confidence *and* a second, independent
signal, and everything weaker — including a timeout — lands in the human queue with the evidence
recorded. They publish one action event per item keyed by the content id so an item's history stays
ordered, carrying the action, the rule and the reviewer's role but never the reporter's identity or
the verbatim report text, and they persist the action before committing the consumer offset so a
crash cannot replay a removal into silence. And they never hand a case file to a caller who does
not own the content, never volunteer who reported it outside the surveyor role, and never echo free
text back unescaped.

## What you build here

One service, **moderated**, with five pieces:

1. \`POST /v1/reports\`: authenticated tenant and reporter, a content id that must belong to the
   tenant (**404** otherwise), a reason from an allowlist (**400** otherwise), an optional detail
   capped at **4 KiB** (**413** otherwise), and a case that is updated rather than duplicated when
   the same reporter reports the same item twice.
2. A **Redis** claim queue: items live in a pending sorted set, a claim pops one and takes a
   **10-minute lease** in a single atomic Lua script, the lease is refreshed while the review
   session is active, and an expired lease puts the item back in the queue.
3. A **gRPC** classifier client: a **400 ms** deadline, retries only on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, an automatic removal only above **0.98** confidence with a
   corroborating signal, and a timeout that routes to humans rather than allowing the content.
4. A **Kafka** \`moderation.action\` topic: one event per action keyed by content id, an idempotent
   producer with \`acks=all\`, a payload with no reporter identity and no free text, an outbox row
   when the broker rejects the produce, and a consumer that persists the action before it commits
   the offset.
5. \`GET /v1/moderation/items/{id}\`: the case file — status, action history and links — scoped to
   the content owner's tenant (**404** for a foreign case), with reporter identity only for the
   surveyor role and the detail text truncated and escaped.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real trust-and-
safety feature: read the draft against the failure modes, name the subtle one, fix it, and prove the
fix with checks that fail on the draft and pass on your version.

## Left out on purpose

Reporter account management, appeals and reinstatement, the human review UI itself, per-jurisdiction
policy packs, model training and evaluation, and long-term evidence retention. The five pieces above
are the ones that decide whether the pipeline is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Reporter', sub: 'POST /v1/reports', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Moderation API', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'db', kind: 'db', label: 'case store', sub: 'cases · actions · outbox', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'queue · leases · counters', x: 46, y: 50},
      {id: 'console', kind: 'service', label: 'Moderator console', sub: 'claim · review', x: 46, y: 86},
      {id: 'classifier', kind: 'grpc', label: 'Classifier', sub: 'Classify · 400 ms', x: 70, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'moderation.action', sub: 'key = content id', x: 70, y: 50},
      {id: 'consumer', kind: 'service', label: 'Moderation consumer', sub: 'group by content', x: 90, y: 50},
      {id: 'queue', kind: 'external', label: 'Human queue', sub: 'triage · surveyors', x: 90, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'cases · actions'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'enqueue · counters'},
      {from: 'api', to: 'classifier', kind: 'grpc', label: 'Classify'},
      {from: 'console', to: 'redis', kind: 'redis', label: 'claim · renew'},
      {from: 'api', to: 'queue', kind: 'plain', label: 'weak evidence'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce moderation.action'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'persist action'},
      {from: 'consumer', to: 'queue', kind: 'plain', label: 'confirmed removals'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
