import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Form service: the course is not "render a form and save the fields", it is the debugging an
 * intake pipeline needs before a public form is pointed at the internet. A submission validates
 * against the form's *published* schema, is rate-limited on form and IP and gated by a one-time
 * captcha → its delivery to downstream handlers is keyed by the submission id → its event is keyed
 * by the form and carries hashes, not values → and the read side redacts by default with an
 * audited, generated export.
 */
export const formServiceProblem: Problem = {
  id: 'form-service',
  title: 'Form Service',
  tagline: 'Public forms with a pinned schema, a one-shot captcha and a redacted read path.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Form Service

A form service takes submissions from the public internet, decides whether to trust them, keeps
them, and hands them to the systems that act on them: a webhook, a CRM, a queue. Whether it is safe
depends on the validation contract, the abuse controls, the delivery key, and the read path.

## The real system

Formspree, a hosted form backend, documents the shape of this problem from the abuse side: every
form gets reCAPTCHA, and a hidden \`_gotcha\` honeypot input causes the server to silently drop any
submission that fills it in, because a scraper fills every field it finds. A form service also
validates against the schema version the author *published*, not the draft still being edited,
because a published form is a contract with the people submitting to it.

## What you build here

One service, **formd**, with five pieces:

1. \`POST /v1/forms/{id}/submissions\`: validates against the **published** schema version pinned at
   load, rejects unknown fields and values beyond their declared \`max_bytes\` with field-level
   errors, escapes markup at rest instead of stripping it, and returns the original
   \`submission_id\` when the same \`(form, Idempotency-Key)\` is replayed.
2. A **Redis** abuse path: a captcha token consumed by one atomic compare-and-delete, and a limit
   reserved on \`limit:form:{id}:{window}\` and \`limit:ip:{ip}:{window}\` by one atomic script that
   answers \`429\` with \`Retry-After\` and \`X-RateLimit-Remaining\`.
3. A **gRPC** handler client: each handler called under a 3-second deadline with the submission id as
   the idempotency key, per-handler outcomes recorded, and a replay that re-invokes only the failed
   handlers.
4. A **Kafka** event path: one \`form.submission\` event per submission keyed by the form id, carrying
   \`field_names\` and a \`value_hash\` rather than the raw values, with an outbox row when the produce is
   rejected.
5. \`GET /v1/forms/{id}/submissions\` and its export: owner-only, redacted by default, cursor-paged,
   with a generated export filename and an audit record for the PII export.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. Debug
it against the failure modes, fix it, and prove the fix with checks that fail on the starter.

## Left out on purpose

Captcha issuance, email verification, file uploads, form authoring and draft publishing,
multi-region storage, GDPR deletion, and the export tool's file writing.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Public submitter', x: 4, y: 42},
      {id: 'admin', kind: 'external', label: 'Admin dashboard', x: 4, y: 74},
      {id: 'api', kind: 'http', label: 'formd API', x: 42, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis limits · captcha', x: 80, y: 12},
      {id: 'handlers', kind: 'grpc', label: 'Handler client', x: 80, y: 38},
      {id: 'kafka', kind: 'kafka', label: 'form.submission', x: 80, y: 62},
      {id: 'db', kind: 'db', label: 'Submissions', x: 42, y: 86},
      {id: 'outbox', kind: 'db', label: 'Outbox', x: 80, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST submission'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'captcha · limits'},
      {from: 'api', to: 'db', kind: 'plain', label: 'store submission'},
      {from: 'api', to: 'handlers', kind: 'grpc', label: 'Deliver'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce event'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'row on reject'},
      {from: 'admin', to: 'api', kind: 'http', label: 'read · export'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
