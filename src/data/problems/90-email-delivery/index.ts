import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Email delivery on the AI-era track: the course is not "call an SMTP server from an endpoint", it
 * is the review you owe a model-generated sender before it mails a customer who unsubscribed.
 * Validated, idempotent sends that check suppression first → one durable, atomic Redis admission →
 * a deadline-bounded gRPC relay call with bounce-aware retries and reconciliation → recipient-keyed
 * lifecycle events with hashed payloads → an honest, tenant-scoped status read.
 */
export const emailDeliveryProblem: Problem = {
  id: 'email-delivery',
  title: 'Email Delivery',
  tagline: 'Send once, bounce cleanly and honor suppression before the relay sees anything.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Email Delivery

An email delivery service is the piece of a platform that takes "send this to this person" and turns
it into a message a relay will accept, then tells the truth about what happened to it afterwards.
The visible part is a message id; the parts that decide whether the platform is safe are the send
funnel in front of the relay, the suppression and rate decision behind it, the failure policy for a
relay that goes quiet, the event stream that records the lifecycle, and the read that reports it.

## The real system

Production senders serve many tenants — marketing, product notifications, transactional mail — and
they treat every field as a claim. A recipient may be suppressed: a bounce, a complaint or an
unsubscribe puts an address on a list that must be durable, because the promise "we will not mail
you again" is not a cache entry. A send must be idempotent, because clients retry and a retry that
mails twice is a bug the recipient sees. The relay is called under a deadline, and its answers are
categorized: a hard bounce is terminal and recorded, a soft bounce may be retried, a server error is
retried with backoff under the same message id, and a timeout leaves the outcome unknown, so it is
reconciled by message id before anything is sent again. Every state change publishes an event keyed
by recipient so a recipient's lifecycle stays ordered, carrying message ids and categories rather
than addresses. And the status read reports relay state, the bounce category, suppression and the
attempt timeline honestly: a message with no confirmed outcome is unknown, not sent.

## What you build here

One service, **mailerd**, with five pieces:

1. \`POST /v1/emails\`: a validated send — recipient, a known template id, merge variables capped at
   8 KiB, no CRLF in the subject or values — that consults suppression **before** the relay call and
   keys a retry by \`(recipient, Idempotency-Key)\`.
2. A **Redis** admission: suppression in a durable set and a per-recipient minute counter, decided in
   one atomic Lua \`EVAL\`, so a burst cannot slip past the cap and an unsubscribe takes effect at once.
3. A **gRPC** relay client: a 10-second deadline, hard bounces terminal and recorded, retries under
   the same message id, a timeout reconciled by message id, and a small retryable set that excludes
   suppressed replies.
4. A **Kafka** event path: \`email.event\` keyed by the recipient hash, \`accepted\` published only after
   the relay confirms, and payloads that carry ids and categories, never addresses.
5. \`GET /v1/messages/{id}\`: the honest read — relay state, bounce category, suppression and the
   attempt timeline — scoped to the caller's tenant, with a foreign id answered as **404**.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

SMTP and DKIM/SPF plumbing, template authoring and rendering engines, attachment storage, bounce
webhook parsing at the provider edge, multi-region relay failover, per-campaign reporting, and the
suppression-list admin UI. The five pieces above are the ones that decide whether the sender is
correct, isolated and shippable.`,
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
