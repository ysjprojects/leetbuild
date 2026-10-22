import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * KYC verification on the AI-era track: the course is not "call an identity vendor from an
 * endpoint", it is the review you owe a model-generated verification flow before it decides who
 * gets an account. A submission endpoint whose verdict is never the caller's → atomic attempt and
 * case state in Redis → a vendor call with a 10-second deadline whose only failure outcome is a
 * human → applicant-keyed decision events carrying digests instead of documents → a scoped status
 * read that hands out short-lived document links.
 */
export const kycVerificationProblem: Problem = {
  id: 'kyc-verification',
  title: 'KYC Verification',
  tagline: 'Identity verification with attempts bounded, vendors decided once and documents scoped.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# KYC Verification

KYC verification is the piece of a fintech platform that decides whether a person may be given an
account: it collects documents, checks them against an identity vendor, records a decision, and
keeps that decision auditable for years. The visible part is a status in an app; the parts that
decide whether the platform is safe are the trust boundary on submission, the atomic attempt and
case state, the failure policy in front of the vendor, the event contract, and the scoped read that
hands out document access.

## The real system

Production verification services receive submissions from many tenants, bind every document
reference to the tenant that owns it, and bound how many times one applicant may try before a human
takes over. They keep one active case per applicant so two submissions cannot race into two
parallel reviews. They call the vendor under a deadline, and — because identity is a legal decision
— they treat a timeout or a vendor error as "a human must look", never as "approved". They publish a
decision event keyed by the applicant so that applicant's history stays ordered, and they carry
document *digests* rather than document images, names or numbers into a topic that is retained and
replicated. And when the app asks for the status, they return the decision and the reason codes the
customer is allowed to see, plus a document link that expires, instead of a permanent URL that
survives every screenshot and share.

## What you build here

One service, **kycd**, with five pieces:

1. \`POST /v1/verifications\`: an authenticated tenant, an applicant reference, document references
   from tenant storage and a document type from an allowlist. The caller submits; the service
   decides — a \`status\` field in the body is ignored and the case opens \`pending\`. Attempts per
   applicant are bounded, and a non-tenant document reference is refused **before** anything is
   fetched.
2. A **Redis** state layer: the attempt bucket and the single active case per applicant, both moved
   by one atomic script each, so a burst cannot exceed the attempt cap or open two cases. The
   refusal carries \`Retry-After\`.
3. A **gRPC** vendor client: \`CheckDocument\` with a 10-second deadline. A timeout or an error routes
   the case to **manual review** marked \`degraded\`; a rejection is terminal and carries the vendor's
   reason. No path from a vendor failure to \`approved\` without a human.
4. A **Kafka** decision path: one \`kyc.decided\` event per decision, keyed by the applicant reference
   so their history stays ordered, carrying the decision, the reasons and document digests — never
   document images, names or numbers — published only **after** the decision record commits.
5. \`GET /v1/applicants/{id}/status\`: the decision, the reason codes and whether the case is
   \`degraded\` or awaiting a human. A foreign applicant is **404**, refusal reasons are the
   customer-facing set, and document images are reachable only through a short-lived signed link.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real KYC feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version. The subtle ones here are the failures that keep
conversion up — approving on a timeout, letting a caller set the verdict, handing out a URL that
never expires — because each of them looks like a feature until the regulator asks.

## Left out on purpose

Vendor selection and contracts, document OCR and liveness capture, sanctions and PEP screening,
appeals and re-verification workflows, reviewer tooling, retention schedules per jurisdiction, and
audit export formats. The five pieces above are the ones that decide whether verification is correct,
isolated and defensible.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Applicant app', sub: 'submit · status', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'KYC API', sub: 'POST /v1/verifications', x: 30, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'attempts · active case', x: 56, y: 12},
      {id: 'vendor', kind: 'grpc', label: 'Vendor', sub: 'CheckDocument · 10 s', x: 56, y: 44},
      {id: 'review', kind: 'service', label: 'Review queue', sub: 'manual · degraded', x: 56, y: 76},
      {id: 'kafka', kind: 'kafka', label: 'kyc.decided', sub: 'key = applicant', x: 80, y: 12},
      {id: 'consumer', kind: 'service', label: 'Status consumer', sub: 'digests · counters', x: 80, y: 44},
      {id: 'db', kind: 'db', label: 'Decision store', sub: 'cases · reasons', x: 80, y: 76},
      {id: 'storage', kind: 'external', label: 'Document storage', sub: 'signed links', x: 30, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/verifications'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'atomic attempt + case'},
      {from: 'api', to: 'vendor', kind: 'grpc', label: 'CheckDocument · deadline 10 s'},
      {from: 'vendor', to: 'review', kind: 'plain', label: 'timeout / error → manual'},
      {from: 'api', to: 'db', kind: 'plain', label: 'commit decision'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'publish kyc.decided after commit'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY counters'},
      {from: 'api', to: 'storage', kind: 'http', label: 'signed URL'},
      {from: 'client', to: 'api', kind: 'http', label: 'GET /v1/applicants/{id}/status'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
