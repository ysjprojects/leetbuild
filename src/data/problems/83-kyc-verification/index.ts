import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * KYC verification: the course is not "call an identity vendor from an endpoint", it is the
 * debugging you owe a verification flow before it decides who gets an account. A submission
 * endpoint whose verdict is never the caller's → one atomic attempt script and one SET NX case
 * claim in Redis → a vendor call with a 10-second deadline whose only failure outcome is a person →
 * applicant-keyed decision events carrying digests after the decision commits → a tenant-scoped
 * status read that hands out expiring document links.
 */
export const kycVerificationProblem: Problem = {
  id: 'kyc-verification',
  title: 'KYC Verification',
  tagline: 'Identity cases with an attempt cap, a vendor deadline, decision events and expiring document links.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# KYC Verification

KYC verification decides whether a person may be given an account: it collects identity documents,
checks them with a vendor, records a decision and keeps it auditable. Most of its flaws raise
conversion: a verdict the caller sets, an approval on a vendor timeout, a document link that never
expires.

## The real system

Stripe Identity models each check as a \`VerificationSession\` whose \`status\` the integrator reads
rather than sets (\`processing\`, \`verified\`, \`requires_input\`), announces changes as webhook
events such as \`identity.verification_session.requires_input\`, and explains a failure in
\`last_error.code\` (\`document_expired\`) separately from a message meant for the user. This course
builds the same split: the service owns the status, and the caller sees codes it can act on.

## What you build here

One service, **kycd**, on the provided \`kyc\` package: \`kyc.cases\` (the case store: \`new_id\`,
\`create\`, \`load\`, \`decide\`, \`lookup\`, \`lookup_any\`; hash \`kyc:case:{case_id}\`),
\`kyc.storage\` (\`put\`, \`fetch\`, \`url\`, \`sign\`, \`resolve\`) and \`kyc.intake\` (step 2's two
functions, provided to step 1):

1. \`POST /v1/verifications\` with \`X-Tenant-Id\` and \`{applicant, documents: [{type, ref}]}\`: an
   allowlisted type, a \`ref\` under \`documents/{tenant}/\`, a case that opens \`pending\`.
2. **Redis** intake state: \`reserve_attempt\` moves \`kyc:attempts:{tenant}:{applicant}\` in one Lua
   script (4 per hour, the refusal carries the seconds left); \`open_case\` claims
   \`kyc:active:{tenant}:{applicant}\` with \`SET NX\`.
3. **gRPC** \`IdentityVendor.CheckDocument\` under a 10-second deadline: only \`APPROVED\` approves, a
   rejection is final with the vendor's codes, a timeout or an error goes to \`manual_review\` marked
   \`degraded\`.
4. A **Kafka** \`kyc.decided\` event per decision, keyed by the applicant, carrying the decision, the
   reason codes and document digests, produced after \`decide\` commits by an idempotent producer.
5. \`GET /v1/applicants/{id}/status\`: the tenant's own applicant only, public reason codes,
   \`degraded\` and \`awaiting_review\`, and document links that expire after 5 minutes.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Vendor selection, OCR and liveness capture, sanctions screening, appeals, reviewer tooling and
retention schedules per jurisdiction.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Applicant app', sub: 'submit · status', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'KYC API', sub: 'POST /v1/verifications', x: 30, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'attempts · active case · cases', x: 56, y: 12},
      {id: 'vendor', kind: 'grpc', label: 'Identity vendor', sub: 'CheckDocument · 10 s', x: 56, y: 44},
      {id: 'review', kind: 'service', label: 'Manual review', sub: 'degraded · awaiting', x: 56, y: 76},
      {id: 'kafka', kind: 'kafka', label: 'kyc.decided', sub: 'key = applicant', x: 80, y: 30},
      {id: 'db', kind: 'db', label: 'Case store', sub: 'kyc:case:{id}', x: 80, y: 70},
      {id: 'storage', kind: 'external', label: 'Document storage', sub: 'digests · signed links', x: 30, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/verifications'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'reserve_attempt · open_case'},
      {from: 'api', to: 'storage', kind: 'http', label: 'fetch digest · sign link'},
      {from: 'api', to: 'vendor', kind: 'grpc', label: 'CheckDocument · deadline 10 s'},
      {from: 'vendor', to: 'review', kind: 'plain', label: 'timeout / error → manual_review'},
      {from: 'api', to: 'db', kind: 'plain', label: 'decide'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'kyc.decided after decide'},
      {from: 'client', to: 'api', kind: 'http', label: 'GET /v1/applicants/{id}/status'},
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
