import {ZILLOW} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {guardEndpointsStep} from './steps/1-guard-endpoints';
import {classifierTiersStep} from './steps/2-classifier-tiers';
import {policyCacheStep} from './steps/3-policy-cache';
import {steerAwayStep} from './steps/4-steer-away';
import {auditEventsStep} from './steps/5-audit-events';

/**
 * Zillow's Fair Housing guardrail, rebuilt as the service a real-estate assistant calls before and
 * after the model: authenticated, capped, version-pinned guard endpoints → a stop list, a fast
 * classifier under a deadline and an LLM judge for the uncertain band, tuned for recall and failing
 * closed → policy, decisions and strikes cached per version in Redis with an atomic publish → the
 * steer-away path that never returns blocked text, regenerates once under the FHA instructions and
 * escalates repeat offenders → an append-only audit trail on Kafka that carries hashes, never text.
 */
export const fairHousingGuardrailProblem: Problem = {
  id: 'fair-housing-guardrail',
  title: 'Fair Housing Guardrail',
  tagline:
    "Zillow's Fair Housing guardrail for an LLM assistant: stop list, classifier and judge tuned for recall, versioned policy, a steer-away reply and an audit trail — reviewed like production.",
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  track: 'ai',
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
assistant. A licensed agent is trained to decline that question; a general-purpose model will answer
it, and in a real-estate transaction that answer is steering under the Fair Housing Act. You own
**fhguard**, the service the assistant calls before the model sees the question and again before the
answer reaches the user. The visible part is a refusal message. The parts that decide whether the
company can put its name on the assistant are the tiers that make the decision, how they are tuned,
what happens when they are down, what the user gets instead of the blocked text, and the record that
proves what was decided under which policy.

## The real system

Zillow built an LLM Fair Housing Guardrail for its conversational real-estate experience and later
open-sourced the classifier behind it. The guardrail is a standalone service with a lexical stop
list and a fine-tuned BERT sequence classifier behind one API, integrated twice around the model: as
a pre-processing step that classifies the user input before the LLM sees it, and as a
post-processing step that reviews the LLM output before it is displayed, with a predefined message
shown instead of flagged output. The prompt carries fair-housing instructions as a third layer. The
service is tuned for recall — a non-compliant answer that slips through is a legal violation, a
compliant query that is refused is a worse product — and it is refreshed from user feedback and
periodic human review of sampled decisions, which fix the stop list and feed harder training examples
to the classifier.

## From the source

*Navigating Fair Housing Guardrails in LLMs* explains why a generic LLM is dangerous in this domain:
the FHA, ECOA and state laws protect race/color, national origin, sex (including sexual orientation
and gender identity), familial status, religion, disability, age, marital status, source of income,
criminal background and military status, and an agent who considers those characteristics when
recommending a home or a neighborhood is steering. Its three worked queries anchor this course: a
neighborhood search by racial makeup (non-compliant), apartments that "do not accept Section 8"
(non-compliant, source of income), and homes with accessible features (compliant, even though it
names a protected class). The post compares three strategies. Prompt instructions are easy and
achieve high recall but refuse all three queries. A stop list is deterministic and right for the
worst phrases but blind to context — "Indian" would also block Indian Wells, CA. A fine-tuned
classifier is fast and has a sensitivity that can be tuned toward recall; training it on
sentence-level labelled model responses as well as queries lifted precision, most at a recall around
0.6. The deployed system combines all three: one service with stop list and classifier, an API used
on the input and on the output, and the FHA instructions in the prompt. This course takes the tier
order, the recall-first tuning, the double integration, the predefined replacement message and the
feedback loop from that post. The LLM judge for the uncertain band, the concrete thresholds, the
deadlines and the policy versioning are this course's engineering choices around the post's design.
The press release *Zillow providing open-source technology…* adds the contract: the classifier flags
noncompliance in the input or the output and leaves the intervention to the developer — which is
exactly the part you build here.

## What you build here

One service, **fhguard**, with five pieces:

1. \`POST /v1/guard/input\` and \`POST /v1/guard/output\`: an \`X-Api-Key\` caller (**401** without),
   an \`X-Policy-Version\` pinned by the conversation (**400** without), \`text\` of at most **8 KiB**
   (**413**), a validated \`conversation_id\`, and a response of \`{allowed, reasons, tier,
   policy_version}\`. No caller flag can skip the guard; the text is never logged.
2. The **gRPC** tiers: the policy's stop list first, then \`Classifier.Classify\` under a **250 ms**
   deadline, blocking at a score of **0.35** and allowing below **0.15**; the band in between goes to
   \`Judge.Judge\` under **2 s**. Any tier error fails **closed** with reason \`guard_unavailable\`.
3. **Redis**: the policy under \`fh:policy:{version}\` with a one-hour TTL and a publish that writes
   the version and swaps \`fh:policy:active\` in one transaction; decisions under
   \`fh:decision:{version}:{sha256}\` for a day so a retry never re-judges; strikes under
   \`fh:strikes:{conversation_id}\` that expire after a day.
4. \`POST /v1/turn\`, the steer-away path: the question is guarded before the model is called; a
   blocked answer is regenerated **once** with the FHA instructions and checked again; what the user
   gets is a compliant answer or the predefined fallback — never the blocked text; the third strike in
   a day escalates the conversation to human review.
5. **Kafka**: one \`fairhousing.audit\` event per decision keyed by conversation — decision, tier,
   score, reasons, policy version and a text hash, never the text — from an idempotent producer with
   an outbox, consumed into an append-only audit store before the offset commit.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Training and evaluating the classifier, the labelled dataset and its augmentation, the multi-class
model, the review tooling humans use, the assistant's own retrieval and tools, multi-region
deployment, and the legal review of the stop list itself. The five pieces above are the ones that
decide whether the guardrail is correct, tuned the right way round, safe when its dependencies fail,
and auditable.`,
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
