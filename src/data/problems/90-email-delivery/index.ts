import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Email delivery: the course is not "call an SMTP server from an endpoint", it
 * is the debugging you owe a sender before it mails a customer who unsubscribed.
 * Validated, idempotent sends that check suppression first → one durable, atomic Redis admission →
 * a deadline-bounded gRPC relay call with bounce-aware retries and reconciliation → recipient-keyed
 * lifecycle events with hashed payloads → a tenant-scoped status read derived from the record.
 */
export const emailDeliveryProblem: Problem = {
  id: 'email-delivery',
  title: 'Email Delivery',
  tagline: 'Suppression before the relay, one message id per retry, and a status read the record backs.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Email Delivery

An email delivery service takes "send this to this person", turns it into a message a relay will
accept, and reports afterwards what happened to it. The parts that decide whether the platform is
safe are the send funnel in front of the relay, the suppression and rate decision behind it, the
failure policy for a quiet relay, the event stream, and the read.

## The real system

Amazon SES keeps an account-level suppression list: when a send bounces or draws a complaint, the
address is added automatically (the \`SuppressedReasons\` setting chooses \`BOUNCE\`, \`COMPLAINT\` or
both), and SES does not attempt delivery to a listed address until it is removed. Suppression is
durable storage, not a cache entry. A send is idempotent because clients retry. Relay answers are
categorized: a hard bounce is terminal and recorded, a server error is retried under the same
message id, and a timeout leaves the outcome unknown, so it is reconciled by message id before any
resend. Events are keyed by recipient and carry message ids and categories rather than addresses.
The status read reports what the record holds: no confirmed outcome means unknown, not sent.

## What you build here

One service, **mailerd**, with five pieces:

1. \`POST /v1/emails\`: a validated send (known template id, merge variables capped at 8 KiB, no
   CRLF in subject or values) that checks suppression before the relay call and keys a retry by
   \`(recipient, Idempotency-Key)\`.
2. A **Redis** admission: suppression in a durable set and a per-recipient minute counter, decided
   in one atomic Lua \`EVAL\`.
3. A **gRPC** relay client: a 10-second deadline, hard bounces terminal and recorded, retries under
   the same message id, a timeout reconciled by message id, suppressed replies not retried.
4. A **Kafka** event path: \`email.event\` keyed by the recipient hash, \`accepted\` published only
   after the relay confirms, payloads that carry ids and categories instead of addresses.
5. \`GET /v1/messages/{id}\`: relay state, bounce category, suppression and the attempt timeline,
   scoped to the caller's tenant, with a foreign id answered as **404**.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path, and
looks right. In each step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

SMTP and DKIM/SPF plumbing, template rendering, attachment storage, bounce webhook parsing,
multi-region relay failover, per-campaign reporting, and the suppression-list admin UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'send · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Email API', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'suppression · rate', x: 48, y: 20},
      {id: 'store', kind: 'db', label: 'message store', sub: 'records · attempts', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'email.event', sub: 'key = recipient hash', x: 48, y: 84},
      {id: 'relay', kind: 'grpc', label: 'Relay', sub: 'SendMail', x: 70, y: 50},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'group email-lifecycle', x: 88, y: 84},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/emails · GET /v1/messages'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'admit · suppression'},
      {from: 'api', to: 'store', kind: 'plain', label: 'records · attempts'},
      {from: 'api', to: 'relay', kind: 'grpc', label: 'SendMail · deadline 10s'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce email.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'lifecycle'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
