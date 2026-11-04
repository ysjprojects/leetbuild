import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Email delivery: the course is not "call an SMTP server from an endpoint", it is the debugging you
 * owe a sender before it mails a customer who unsubscribed. Refusals before the queue → a durable
 * suppression set and an atomic per-recipient count in one Lua script → relay calls under one
 * message id, reconciled after a timeout, with hard bounces suppressed → recipient-keyed events
 * published after the relay answered → a tenant-scoped status read that repeats the record.
 */
export const emailDeliveryProblem: Problem = {
  id: 'email-delivery',
  title: 'Email Delivery',
  tagline: 'A durable suppression set, one message id per relay retry, and a status read the record backs.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Email Delivery

An email delivery service takes "send this template to this person", hands it to a relay that
speaks SMTP, and reports afterwards what became of it. Most of what can go wrong cannot be undone:
a mail that went out stays out. So the service decides everything it can before the relay is
asked, and reports no outcome the relay did not give.

## The real system

Amazon SES keeps an account-level suppression list: an address that hard-bounces or draws a
complaint is added automatically (the \`SuppressedReasons\` setting picks \`BOUNCE\`, \`COMPLAINT\` or
both, and accounts opened since November 2019 suppress both by default), and SES does not send to
a listed address until it is removed. This course builds the same shape: suppression is durable,
checked before the send and fed by the relay's bounces; retries carry the message's own id; and the
status a customer sees is the one the relay reported.

## What you build here

One service, **mailerd**, on one message store (\`mail.store\`, provided: \`mail:msg:{id}\` hashes,
the \`mail:queue\` list, \`mail:msg:{id}:attempts\` timelines and \`mail:send:{tenant}:{key}\`
idempotency records) and one address helper (\`mail.address\`: \`normalize\`, \`recipient_hash\`).
Step 2's gate is provided to the other steps as \`mail.gate\`, step 3's relay client as
\`mail.relay\`.

1. \`POST /v1/emails\` \`{recipient, template_id, subject, variables}\` with \`Idempotency-Key\` and
   \`X-Tenant-Id\`: validation, a replay answered by \`find_send\`, \`gate.admit\`, then \`enqueue\`.
2. A **Redis** gate: \`suppress\`, \`is_suppressed\` and \`admit\` over the set \`mail:suppressed\` and
   the minute counter \`mail:rate:{address}:{window}\`, decided in one Lua script.
3. A **gRPC** relay client, \`deliver(message_id)\`: \`Relay.SendMail\` under a 10-second deadline
   and the message's own id, \`GetStatus\` after a timeout, hard bounces recorded and suppressed.
4. A **Kafka** \`email.event\` stream: \`dispatch(message_id)\` delivers, then publishes
   \`EVENT_TYPES[state]\` keyed by \`recipient_hash\` from an idempotent producer.
5. \`GET /v1/messages/{id}\`: state, bounce category, suppression and the attempt timeline, for
   the caller's tenant only.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path, and
looks right. In each step you debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

SMTP, DKIM and SPF, template rendering, attachments, parsing bounce webhooks, relay failover
across regions, campaign reporting, and the admin screens of the suppression list.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'send · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'mailerd', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis gate', sub: 'mail:suppressed · mail:rate', x: 50, y: 16},
      {id: 'store', kind: 'db', label: 'message store', sub: 'mail:msg · mail:queue · attempts', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'email.event', sub: 'key = recipient hash', x: 50, y: 84},
      {id: 'relay', kind: 'grpc', label: 'Relay', sub: 'SendMail · GetStatus · 10 s', x: 74, y: 50},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'group email-lifecycle', x: 88, y: 84},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/emails · GET /v1/messages'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'admit · suppress (one Lua script)'},
      {from: 'api', to: 'store', kind: 'plain', label: 'enqueue · attempts · state'},
      {from: 'api', to: 'relay', kind: 'grpc', label: 'SendMail(message_id) · GetStatus'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the relay answered'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
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
