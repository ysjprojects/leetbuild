import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Session store on the AI-era track: the course is the review you owe a model-generated session
 * layer before it guards a platform. Rotation that mints a new id and retires the old one →
 * Redis records with a sliding TTL under a hard absolute cap and an atomic rotation → a gRPC
 * validation path with a short cache that fails closed on timeout → session events keyed by user
 * carrying hashes, never tokens, persisted before publish → a read endpoint whose last-seen is
 * accurate, whose revoke-all is atomic and whose sessions are private.
 */
export const sessionStoreProblem: Problem = {
  id: 'session-store',
  title: 'Session Store',
  tagline: 'Session tokens that rotate, fail closed and never outlive their notice.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Session Store

A session store is the piece of a platform that decides which requests are authenticated, for how
long a login may live, and what a user is allowed to see about their own sessions. The visible part
is a token in a cookie; the parts that decide whether the platform is safe are the rotation on
elevation, the atomicity of every write, the failure policy of the auth call, and the events the
platform keeps about itself.

## The real system

Production session layers issue an id at login and a new id at every privilege elevation, so a
pre-login id can never become authenticated. They keep records in Redis under a sliding TTL so active
users are not logged out, but under a hard absolute cap so a stolen token cannot live forever, and
they write the replacement before retiring the original in one atomic step so a crash cannot leave
two live sessions. They validate tokens against an auth service with a deadline and a short cache,
and when that service is unavailable they deny the request rather than trusting a local copy. They
publish one event per session change keyed by user so a user's history stays ordered, carrying a
token hash and never the token, and they persist the session record before announcing it. And they
show a user exactly what is live: device class, last-seen within a minute, rotation count, and one
action that revokes every id atomically.

## What you build here

One service, **sessiond**, with five pieces:

1. \`POST /v1/sessions\`: an id from the completed auth flow, a device class taken from the token, a
   fresh session id on every elevation, and the old id invalidated in the same request. A session
   created without a completed auth assertion is rejected.
2. A **Redis** record per session: a sliding TTL refreshed on use, a hard absolute TTL that use
   cannot extend, and rotation that writes the new record and retires the old one atomically so a
   crash leaves exactly one live id.
3. A **gRPC** auth client: a 150 ms deadline per validation, a short positive cache, a timeout that
   denies the request, a revocation that is visible within the cache window, and a rejection that is
   terminal — never retried.
4. A **Kafka** \`session.event\` path: events keyed by user id for per-user ordering, device class
   and a token hash in the payload, the raw token never published or logged, and the session record
   committed before the event is produced.
5. \`GET /v1/users/{id}/sessions\`: active sessions with device class, last-seen within one minute
   and rotation count, a revoke-all that invalidates every id before returning, and **403** when a
   caller asks for another user's sessions.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real session
layer: read the draft against the failure modes, name the subtle one, fix it, and prove the fix with
checks that fail on the draft and pass on your version.

## Left out on purpose

SSO federation, password and MFA flows, cookie and CSRF policy at the edge, device fingerprinting,
session replay protection, and user-facing session management UI. The five pieces above are the ones
that decide whether the session layer is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'browser · device', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Session API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Session Store', sub: 'sliding TTL · rotation', x: 44, y: 50},
      {id: 'auth', kind: 'grpc', label: 'Auth Service', sub: 'Validate / Revoke', x: 44, y: 12},
      {id: 'db', kind: 'db', label: 'Session Index', sub: 'last-seen · devices', x: 44, y: 86},
      {id: 'kafka', kind: 'kafka', label: 'session.event', sub: 'key = user', x: 66, y: 50},
      {id: 'consumer', kind: 'service', label: 'Session consumer', sub: 'audit · analytics', x: 84, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'auth', kind: 'grpc', label: 'Validate / Revoke'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'session record'},
      {from: 'api', to: 'db', kind: 'plain', label: 'session index'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce session.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
