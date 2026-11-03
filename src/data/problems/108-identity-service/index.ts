import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Identity service: the course is not "store a user row", it is the debugging you owe a signup
 * path before it hands accounts to people who never proved they own the address. Normalized,
 * idempotent signup → one atomic Redis claim per identity handle → a gRPC verification call with a
 * deadline and a queued retry → user-keyed lifecycle events with minimal PII published after the
 * commit → a profile read that scopes the owner, the public projection and the audited support
 * path.
 */
export const identityServiceProblem: Problem = {
  id: 'identity-service',
  title: 'Identity Service',
  tagline: 'Signup, Redis handle claims, a verification round trip and a profile read with one owner.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Identity Service

An identity service decides who a person is, whether two signups are the same human, whether an
address is really theirs, and what the rest of the platform may know about them.

## The real system

Keycloak, the open source identity provider, lowercases every username and email before it stores
them, so \`Alice@x.com\` and \`alice@x.com\` are one account and the uniqueness index compares
canonical forms. Production services go further: phone numbers are canonicalized to E.164,
uniqueness is an atomic claim per handle rather than a read then a write, verification is a round
trip under a deadline, lifecycle events carry reason codes rather than contact data, and support
staff read records only through an audited tool.

## What you build here

One service, **identityd**, with five pieces:

1. \`POST /v1/users\`: a normalized email (case folding, dot handling for the domain's policy,
   plus-alias policy) and phone, an \`Idempotency-Key\` so a retried signup returns the original
   account, and a response that never confirms to an unauthenticated caller whether an address
   already exists.
2. A **Redis** claim: one set-if-absent key per handle in a durable namespace, so email and phone
   each have their own claim, a concurrent signup for one handle loses cleanly, and an aborted
   signup releases every key it claimed.
3. A **gRPC** verification client: a 3-second deadline per send, a timeout that queues a retry and
   leaves the account unverified, a hard bounce that is terminal and suppresses the address, and a
   verification granted only from the provider's confirmation.
4. A **Kafka** event path: \`identity.event\` keyed by user id, carrying the event kind and a reason
   code but no email, phone or name, produced after the account write commits, with an idempotent
   producer and \`acks=all\`.
5. \`GET /v1/users/{id}\`: the owner's full record, a public projection with no contact data and
   always a verification state, and a support path that reads only through an audit record.

## The debugging habit

Every starter compiles and serves the happy path. Debug it against the failure modes, fix it, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Password and passkey storage, session and token issuance, OAuth and social login, account deletion
and data export workflows, carrier phone verification, multi-region replication of the account store,
and admin tooling. The five pieces above are the ones that decide whether identities are unique,
deliberately verified and minimally exposed.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'signup / profile', x: 6, y: 40},
      {id: 'api', kind: 'http', label: 'identityd', sub: ':8443', x: 28, y: 40},
      {id: 'redis', kind: 'redis', label: 'Handle claims', sub: 'identity:handle:*', x: 52, y: 8},
      {id: 'db', kind: 'db', label: 'Accounts', sub: 'users', x: 52, y: 40},
      {id: 'provider', kind: 'grpc', label: 'Verification provider', sub: ':443', x: 78, y: 8},
      {id: 'retry', kind: 'service', label: 'Verification queue', sub: 'retry', x: 78, y: 40},
      {id: 'kafka', kind: 'kafka', label: 'identity.event', sub: 'topic', x: 78, y: 72},
      {id: 'support', kind: 'external', label: 'Support console', sub: 'audited lookup', x: 28, y: 78},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/users'},
      {from: 'client', to: 'api', kind: 'http', label: 'GET /v1/users/{id}'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET NX handle'},
      {from: 'api', to: 'db', kind: 'plain', label: 'commit account'},
      {from: 'api', to: 'provider', kind: 'grpc', label: 'SendVerification'},
      {from: 'api', to: 'retry', kind: 'plain', label: 'queue on timeout'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'publish after commit'},
      {from: 'support', to: 'api', kind: 'http', label: 'audited read'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
