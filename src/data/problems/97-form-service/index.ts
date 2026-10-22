import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Form service on the AI-era track: the course is not "render a form and save the fields", it is the
 * review you owe a model-generated intake pipeline before a public form is pointed at the internet.
 * A submission validates against the form's *published* schema, is rate-limited on form and IP and
 * gated by a one-time captcha → its delivery to downstream handlers is keyed by the submission id →
 * its event is keyed by the form and carries hashes, not values → and the read side redacts by
 * default with an audited, generated export.
 */
export const formServiceProblem: Problem = {
  id: 'form-service',
  title: 'Form Service',
  tagline: 'Public forms that resist spam, validate precisely and deliver submissions once.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Form Service

A form service is the piece of a product that takes submissions from the public internet, decides
whether to trust them, keeps them, and hands them to the systems that act on them — a webhook, a
CRM, a queue. The visible part is a submit button; the parts that decide whether it is safe are the
validation contract, the abuse controls, the delivery key, and the read path.

## The real system

Production form services receive submissions from anyone, so every request is hostile until proven
otherwise. They validate against the schema version the author *published*, not the draft still
being edited, because a published form is a contract with the people submitting to it. They reject
unknown fields and oversized values field by field so the client learns what to fix. They assume a
public endpoint will be scraped: a captcha token is consumed exactly once, and submissions are
limited on the form and the submitter address together, so neither one address nor a botnet can
sweep a form. Markup in a field is escaped at rest, because the admin dashboard renders it and an
unescaped \`<script>\` is a stored-XSS hole. Downstream delivery is keyed by the submission id, so a
retry is not a second lead. Events are keyed by the form so intake stays ordered and carry hashes
rather than values, because a topic is retained and replicated. And the read side redacts personal
data by default, with a separate, audited export for the callers who are allowed to see it.

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
   \`field_names\` and a \`value_hash\` — never the raw values — with an outbox row when the produce is
   rejected.
5. \`GET /v1/forms/{id}/submissions\` and its export: owner-only, redacted by default, cursor-paged,
   with a generated export filename and an audit record for the PII export.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Captcha issuance and scoring, email verification, file uploads, form authoring and draft publishing,
multi-region storage, GDPR deletion workflows, and the export tool's own file writing. The five
pieces above are the ones that decide whether the service is correct, safe and shippable.`,
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
