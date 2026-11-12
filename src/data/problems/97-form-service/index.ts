import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Form service: the course is not "render a form and save the fields", it is the debugging an
 * intake pipeline needs before a public form is pointed at the internet. A submission validates
 * against the form's published schema → a captcha is consumed once and a limit reserved on form and
 * address in one script → delivery to downstream handlers is keyed per submission and handler →
 * its event is keyed by the form and carries hashes, not values → the read side redacts by default
 * with an audited, generated export.
 */
export const formServiceProblem: Problem = {
  id: 'form-service',
  title: 'Form Service',
  tagline: 'Public form submissions checked against the published schema and read back redacted.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Form Service

A form service takes submissions from the public internet, decides whether to trust them, keeps
them, and hands them to the systems that act on them. Every part of it is a decision about
strangers: which fields they may write, how often, what downstream systems hear about them, and who
may read what they wrote.

## The real system

Formspree, a hosted form backend, documents the abuse side of it: every form gets reCAPTCHA, and
when a hidden \`_gotcha\` input arrives filled in, its servers take the submission for a bot's and
silently ignore it, because a scraper fills every field it finds. This course builds what sits
around such a filter: a published schema as the contract with submitters, limits that hold under
parallel requests, delivery a retry cannot double, events without the values, and a read path that
redacts by default.

## What you build here

One service, **formd**, on one form store (\`forms.store\`, provided, in Redis: \`form:{id}\` with the
owner and the published and draft schema versions, \`submission:{id}\`, \`form:{id}:submissions\`
ordered by seq, \`form:{id}:key:{key}\`, and the \`outbox\` and \`audit\` lists):

1. \`POST /v1/forms/{id}/submissions\` with \`{"fields": {...}}\` and an \`Idempotency-Key\`:
   validated against \`published_schema\` field by field (422), values escaped at rest, and a replay
   answers the original \`submission_id\`.
2. A **Redis** abuse path, \`consume_captcha(token)\` and \`reserve(form_id, ip)\`: \`captcha:{token}\`
   consumed once with \`GETDEL\`, and one Lua script reserving \`limit:form:{id}:{window}\` and
   \`limit:ip:{ip}:{window}\` together.
3. A **gRPC** delivery, \`deliver(submission_id)\`, to \`formd.Handler/Deliver\` at \`webhook:9000\`,
   \`crm:9000\` and \`queue:9000\`: key \`{submission_id}:{handler}\`, a 3-second deadline, outcomes in
   \`delivery:{submission_id}\`, and a replay that calls only the handlers that failed.
4. A **Kafka** event, \`publish_submission(submission)\`: one \`form.submission\` record keyed by the
   form id with \`field_names\` and a \`value_hash\`, from an idempotent producer with \`acks=all\`,
   falling back to the outbox.
5. \`GET /v1/forms/{id}/submissions\` and \`POST /v1/forms/{id}/exports\` for the form's owner
   (\`X-User-Id\`): redacted by default, paged by cursor, and an export under a generated file name
   with an audit row.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Captcha issuance, honeypot fields, email verification, file uploads, form authoring and publishing,
multi-region storage, GDPR deletion, and the relay that drains the outbox.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Public submitter', x: 4, y: 42},
      {id: 'admin', kind: 'external', label: 'Form owner', x: 4, y: 74},
      {id: 'api', kind: 'http', label: 'formd API', x: 42, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis captcha · limits', x: 80, y: 12},
      {id: 'handlers', kind: 'grpc', label: 'Handlers webhook · crm · queue', x: 80, y: 38},
      {id: 'kafka', kind: 'kafka', label: 'form.submission', x: 80, y: 62},
      {id: 'db', kind: 'db', label: 'Form store', x: 42, y: 86},
      {id: 'outbox', kind: 'db', label: 'Outbox · audit', x: 80, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST submission'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'GETDEL captcha · reserve'},
      {from: 'api', to: 'db', kind: 'plain', label: 'published schema · submissions'},
      {from: 'api', to: 'handlers', kind: 'grpc', label: 'Deliver · 3 s'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'key = form id'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'row on reject · export audit'},
      {from: 'admin', to: 'api', kind: 'http', label: 'read · export'},
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
