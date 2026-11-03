import {ZILLOW} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {guardEndpointsStep} from './steps/1-guard-endpoints';
import {classifierTiersStep} from './steps/2-classifier-tiers';
import {policyCacheStep} from './steps/3-policy-cache';
import {steerAwayStep} from './steps/4-steer-away';
import {auditEventsStep} from './steps/5-audit-events';

/**
 * Zillow's Fair Housing guardrail, rebuilt as the service a real-estate assistant calls before and
 * after the model: authenticated, capped, version-pinned guard endpoints; a stop list, a fast
 * classifier under a deadline and an LLM judge for the uncertain band, tuned for recall and failing
 * closed; policy, decisions and strikes cached per version in Redis with an atomic publish; the
 * steer-away path that returns a fixed fallback instead of blocked text, regenerates once under the
 * FHA instructions and escalates repeat offenders; an append-only audit trail on Kafka that carries
 * text hashes.
 */
export const fairHousingGuardrailProblem: Problem = {
  id: 'fair-housing-guardrail',
  title: 'Fair Housing Guardrail',
  tagline:
    "Zillow's Fair Housing guardrail for an LLM assistant: a stop list, a recall-tuned classifier with an LLM judge for the uncertain band, versioned policy in Redis, a fixed fallback instead of blocked text, and a hashed audit trail on Kafka.",
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  tag: 'ai-systems',
  minutes: 75,
  company: ZILLOW,
  sources: [
    {
      title: 'Navigating Fair Housing Guardrails in LLMs',
      url: 'https://www.zillow.com/news/navigating-fair-housing-guardrails-in-llms',
      by: 'Anusha Bagalkotkar',
      date: '2024-01-16',
      takes:
        'The system and its reasons: steering as the risk an LLM in a real-estate conversation creates under the Fair Housing Act; the protected classes; three strategies — prompt instructions, a lexical stop list, a fine-tuned fast classifier with a tunable threshold — and their trade-offs; recall over precision because a missed violation costs more than a refused query; one standalone service that combines the stop list and the classifier, called on the user input and again on the model output, with a predefined message shown instead of flagged output; stop list and training data refreshed from user feedback and sampled human review.',
    },
    {
      title: 'Zillow providing open-source technology to promote fair housing in AI-powered real estate conversations',
      url: 'https://www.zillow.com/news/zillow-providing-open-source-technology-to-promote-fair-housing-in-ai-powered-real-estate-conversations',
      date: '2024-05-21',
      takes:
        'The open-sourced Fair Housing Classifier as a protective measure that flags noncompliance in the input or the output and leaves the intervention to the system developer — the contract behind the guard endpoints, the steer-away reply and the audit trail built here.',
    },
  ],
  statement: `# Fair Housing Guardrail

A user types "what is a good neighborhood for Latino families in Seattle" into a real-estate
assistant. A licensed agent declines that question; a general-purpose model answers it, and that
answer is steering under the Fair Housing Act. You own **fhguard**, the service the assistant calls
before the model sees the question and again before the answer reaches the user: the tiers that
decide, how they are tuned, what happens when they are down, and the record of what was decided
under which policy.

## The real system

Zillow built an LLM Fair Housing Guardrail for its conversational real-estate experience and
open-sourced the classifier as \`zillow/fair-housing-guardrail\`. The library runs text through a
customizable stop list and a fine-tuned BERT-base binary classifier with a sigmoid output and a
configurable threshold (default 0.5), and ships a RoBERTa-large multi-class variant that names the
protected class, such as \`non-compliant-age\`. Zillow runs it on the user input and on the model
output, shows a predefined message instead of flagged output, and pairs it with fair-housing
instructions in the prompt.

## From the source

*Navigating Fair Housing Guardrails in LLMs* gives three worked queries: a neighborhood search by
racial makeup (non-compliant), apartments that "do not accept Section 8" (non-compliant, source of
income), and homes with accessible features (compliant). The course takes the tier order, the
recall-first tuning, the double integration and the replacement message from the post; the LLM
judge, the thresholds, the deadlines and the policy versioning are this course's choices.

## What you build here

1. \`POST /v1/guard/input\` and \`/output\`: \`X-Api-Key\` (**401**), \`X-Policy-Version\`
   (**400**), \`text\` of at most **8 KiB** (**413**), \`{allowed, reasons, tier, policy_version}\`.
   No skip flag; the text stays out of the log.
2. The **gRPC** tiers: stop list, \`Classify\` under **250 ms**, block at **0.35**, allow below
   **0.15**, the band to \`Judge\` under **2 s**; any error fails closed.
3. **Redis**: \`fh:policy:{version}\` with a TTL and a transactional publish that swaps
   \`fh:policy:active\`; decisions under \`fh:decision:{version}:{sha256}\`; strikes that expire.
4. \`POST /v1/turn\`: guard the question first, regenerate a blocked answer **once** under the FHA
   instructions and recheck it, return the fallback instead of blocked text, escalate the third
   strike to human review.
5. **Kafka**: one \`fairhousing.audit\` event per decision keyed by conversation, carrying a text
   hash, from an idempotent producer with an outbox, appended before the offset commit.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Training the classifier, the labelled dataset, the review tooling, the assistant's own retrieval,
and the legal review of the stop list itself.`,
  diagram: {
    nodes: [
      {
        id: 'assistant',
        kind: 'client',
        label: 'Real-estate assistant',
        sub: 'turn · guard input · guard output',
        x: 6,
        y: 50,
      },
      {id: 'guard', kind: 'http', label: 'fhguard', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'policy', kind: 'db', label: 'policy store', sub: 'versions · stop lists · outbox', x: 42, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'policy · decisions · strikes', x: 42, y: 36},
      {id: 'kafka', kind: 'kafka', label: 'fairhousing.audit', sub: 'key = conversation', x: 42, y: 88},
      {id: 'classifier', kind: 'grpc', label: 'FH classifier', sub: 'Classify · 250 ms', x: 62, y: 18},
      {id: 'judge', kind: 'grpc', label: 'LLM judge', sub: 'Judge · 2 s · uncertain band', x: 62, y: 42},
      {id: 'model', kind: 'external', label: 'Model', sub: 'complete · FHA instructions', x: 62, y: 64},
      {id: 'consumer', kind: 'service', label: 'Audit consumer', sub: 'group audit', x: 62, y: 90},
      {id: 'review', kind: 'external', label: 'Review queue', sub: 'repeat offenders', x: 80, y: 64},
      {id: 'audit', kind: 'db', label: 'audit store', sub: 'append-only', x: 80, y: 90},
    ],
    edges: [
      {from: 'assistant', to: 'guard', kind: 'http', label: 'HTTPS'},
      {from: 'guard', to: 'policy', kind: 'plain', label: 'policy · outbox'},
      {from: 'guard', to: 'redis', kind: 'redis', label: 'policy · decisions · strikes'},
      {from: 'guard', to: 'classifier', kind: 'grpc', label: 'Classify'},
      {from: 'guard', to: 'judge', kind: 'grpc', label: 'Judge (band only)'},
      {from: 'guard', to: 'model', kind: 'plain', label: 'complete · regenerate once'},
      {from: 'guard', to: 'review', kind: 'plain', label: 'escalate at 3 strikes'},
      {from: 'guard', to: 'kafka', kind: 'kafka', label: 'produce fairhousing.audit'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'audit', kind: 'plain', label: 'append, then commit'},
    ],
  },
  steps: [guardEndpointsStep, classifierTiersStep, policyCacheStep, steerAwayStep, auditEventsStep],
};
