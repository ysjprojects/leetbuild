import {ZILLOW} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {guardEndpointsStep} from './steps/1-guard-endpoints';
import {classifierTiersStep} from './steps/2-classifier-tiers';
import {policyCacheStep} from './steps/3-policy-cache';
import {steerAwayStep} from './steps/4-steer-away';
import {auditEventsStep} from './steps/5-audit-events';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Zillow's Fair Housing guardrail, rebuilt as the service a real-estate assistant calls before and
 * after the model. One `fhguard` support package carries the contract every step shares: the
 * store (keys, policy versions, review queue, audit rows, outbox), the policy cache, the tiers and
 * the model client. Guard routes → gRPC tiers that fail closed → versioned policy, decisions and
 * strikes in Redis → the turn route that answers a fallback and regenerates once → a hashed,
 * conversation-keyed audit trail on Kafka.
 */
export const fairHousingGuardrailProblem: Problem = {
  id: 'fair-housing-guardrail',
  title: 'Fair Housing Guardrail',
  tagline:
    "Zillow's Fair Housing guardrail for a real-estate assistant: gRPC tiers that fail closed, policy versions in Redis, a fallback reply in place of blocked text and a hashed audit trail on Kafka.",
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
        'The system and its reasons: steering as the risk an LLM in a real-estate conversation creates under the Fair Housing Act; the protected classes; three strategies (prompt instructions, a lexical stop list, a fine-tuned fast classifier with a tunable threshold) and their trade-offs; recall over precision because a missed violation costs more than a refused query; one standalone service that combines the stop list and the classifier, called on the user input and again on the model output, with a predefined message shown instead of flagged output; stop list and training data refreshed from user feedback and sampled human review.',
    },
    {
      title: 'Zillow providing open-source technology to promote fair housing in AI-powered real estate conversations',
      url: 'https://www.zillow.com/news/zillow-providing-open-source-technology-to-promote-fair-housing-in-ai-powered-real-estate-conversations',
      date: '2024-05-21',
      takes:
        'The open-sourced Fair Housing Classifier as a protective measure that flags noncompliance in the input or the output and leaves the intervention to the system developer: the contract behind the guard endpoints, the steer-away reply and the audit trail built here.',
    },
  ],
  statement: `# Fair Housing Guardrail

A user asks a real-estate assistant for "a good neighborhood for Latino families in Seattle". A
licensed agent declines; a general-purpose model answers, and that answer is steering under the
Fair Housing Act. You own **fhguard**, the service the assistant calls before the model sees the
question and again before the answer reaches the user.

## The real system

Zillow open-sourced its LLM guardrail as \`zillow/fair-housing-guardrail\`: a customizable stop
list plus a fine-tuned BERT-base binary classifier with a sigmoid output and a configurable
threshold (default 0.5), and a RoBERTa-large variant that names the protected class
(\`non-compliant-age\`). Zillow runs it on the user input and on the model output, shows a
predefined message instead of flagged output, and adds fair-housing instructions to the prompt.

## From the source

*Navigating Fair Housing Guardrails in LLMs* gives three worked queries: a neighborhood search by
racial makeup and apartments that "do not accept Section 8" (both non-compliant), and homes with
accessible features (compliant). The tier order, recall-first tuning, double integration and
replacement message come from the post; the judge, thresholds, deadlines and policy versions are
this course's choices.

## What you build here

Every step imports the \`fhguard\` package: \`store\` (API keys, policy versions, review queue,
audit rows, outbox), \`tiers\` (\`decide\` and \`evaluate(text, policy_version)\`), \`cache\` and
\`model\`. The checks serve the classifier, the judge and the model over gRPC.

1. \`POST /v1/guard/input\` and \`/output\`: \`X-Api-Key\` (**401**), \`X-Policy-Version\`
   (**400**), \`text\` of at most **8 KiB** (**413**), answering
   \`{direction, allowed, reasons, tier, policy_version}\`.
2. The **gRPC** tiers in \`decide(text, policy)\`: the stop list, \`Classifier.Classify\` under
   **250 ms**, block at **0.35**, allow below **0.15**, the band to \`Judge.Assess\` under **2 s**;
   any RPC error fails closed.
3. **Redis**: \`fh:policy:{version}\` for an hour and \`fh:policy:active\` moved in one MULTI/EXEC;
   decisions under \`fh:decision:{version}:{sha256}\`; strikes in \`fh:strikes:{conversation_id}\`
   that expire a day after the first.
4. \`POST /v1/turn\`: evaluate the question first, regenerate a blocked answer **once** under the
   FHA instructions (\`Assistant.Complete\`), answer the fallback in place of blocked text, send the
   third strike to human review.
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
      {id: 'policy', kind: 'db', label: 'fhguard store', sub: 'keys · policy versions · outbox', x: 42, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'policy · decisions · strikes', x: 42, y: 36},
      {id: 'kafka', kind: 'kafka', label: 'fairhousing.audit', sub: 'key = conversation', x: 42, y: 88},
      {id: 'classifier', kind: 'grpc', label: 'FH classifier', sub: 'Classify · 250 ms', x: 62, y: 18},
      {id: 'judge', kind: 'grpc', label: 'LLM judge', sub: 'Assess · 2 s · uncertain band', x: 62, y: 42},
      {id: 'model', kind: 'grpc', label: 'Assistant model', sub: 'Complete · FHA instructions', x: 62, y: 64},
      {id: 'consumer', kind: 'service', label: 'Audit consumer', sub: 'group audit', x: 62, y: 90},
      {id: 'review', kind: 'external', label: 'Review queue', sub: 'repeat offenders', x: 80, y: 64},
      {id: 'audit', kind: 'db', label: 'audit store', sub: 'append-only', x: 80, y: 90},
    ],
    edges: [
      {from: 'assistant', to: 'guard', kind: 'http', label: 'HTTPS'},
      {from: 'guard', to: 'policy', kind: 'plain', label: 'policy · outbox'},
      {from: 'guard', to: 'redis', kind: 'redis', label: 'policy · decisions · strikes'},
      {from: 'guard', to: 'classifier', kind: 'grpc', label: 'Classify'},
      {from: 'guard', to: 'judge', kind: 'grpc', label: 'Assess (band only)'},
      {from: 'guard', to: 'model', kind: 'grpc', label: 'Complete · regenerate once'},
      {from: 'guard', to: 'review', kind: 'plain', label: 'escalate at 3 strikes'},
      {from: 'guard', to: 'kafka', kind: 'kafka', label: 'produce fairhousing.audit'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'audit', kind: 'plain', label: 'append, then commit'},
    ],
  },
  steps: [guardEndpointsStep, classifierTiersStep, policyCacheStep, steerAwayStep, auditEventsStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
