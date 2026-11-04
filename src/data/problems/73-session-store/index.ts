import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Session store: the course is not "put a token in Redis", it is the debugging you owe a session
 * layer before it guards a platform. A login that mints its own id and retires the presented one →
 * a Redis lifecycle with a sliding expiry under a hard cap and a rotation in one script → a gRPC
 * validation client with a short cache that fails closed → user-keyed session events carrying a
 * token hash, produced after the commit → a session page that shows only your live sessions and a
 * sign-out-everywhere that cannot miss a login.
 */
export const sessionStoreProblem: Problem = {
  id: 'session-store',
  title: 'Session Store',
  tagline: 'Session ids minted at every login, and a validation cache that fails closed when the auth service is down.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Session Store

A session store decides which requests are signed in, for how long, and who may see or end a
session. The visible part is an id in a cookie; the rest is a set of promises about that id: the
server chose it, it stops working once retired, it is gone after a quiet quarter of an hour, and it
is gone after eight hours whatever happens.

## The real system

Spring Security's \`ChangeSessionIdAuthenticationStrategy\`, its default protection against session
fixation, gives the HTTP session a new id the moment authentication succeeds. Spring Session's
\`RedisIndexedSessionRepository\` keeps each session as a Redis hash with \`creationTime\`,
\`lastAccessedTime\` and \`maxInactiveInterval\` (1800 s by default) and indexes sessions by principal
name, so an application can list or end every session of one user. This course builds the same shape
and adds what that leaves to you: an absolute cap the sliding expiry cannot pass, a rotation that is
one atomic script, and a sign-out-everywhere that cannot miss a login.

## What you build here

One service, **sessiond**, on one store (\`sessions.store\`, provided): \`session:{id}\` is a hash
with \`user_id\`, \`device_class\`, \`token_hash\`, \`created_at\`, \`last_seen\` and \`rotation\`, expiring
\`SLIDING_TTL_S\` (15 min) after its last use; \`user:{id}:sessions\` is the set of a user's ids;
\`assertion:{token}\` is what the login flow saw. Step 2's \`rotate_session\` and \`touch_session\` are
provided to the later steps as \`sessions.state\`.

1. \`POST /v1/sessions\`: a complete login assertion opens a session under a fresh id
   (\`new_session_id\`, \`put_session\`) and retires the id the client presented (\`retire_session\`).
2. A **Redis** lifecycle: \`touch_session\` slides the expiry and enforces \`ABSOLUTE_TTL_S\` (8 h);
   \`rotate_session\` moves a session to a new id in one Lua script, keeping \`created_at\`.
3. A **gRPC** client of \`sessionauth.Auth\` (\`Validate\`, \`Revoke\`): a 150 ms deadline, a 30 s
   positive cache, a denial on any failure.
4. A **Kafka** \`session.event\` stream keyed by user id and carrying \`token_hash\`, produced after
   the commit by an idempotent producer, with an outbox (\`outbox_add\`) for what the broker refuses.
5. \`GET /v1/users/{id}/sessions\` and its \`DELETE\` (sign out everywhere): the caller's own
   sessions only, live records only, and one script that ends them all.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and it
looks right. In every step, debug it against the failure modes the task names, fix it, and prove the
fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Password and MFA flows (the assertion is their output), SSO federation, cookie attributes and CSRF at
the edge, device fingerprinting, and the consumers of \`session.event\`. The five pieces above decide
whether a session ends when it should.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'browser · X-Session-Id', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'sessiond', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'session:{id} · user:{id}:sessions', x: 48, y: 50},
      {id: 'auth', kind: 'grpc', label: 'Auth service', sub: 'Validate · Revoke · 150 ms', x: 48, y: 14},
      {id: 'kafka', kind: 'kafka', label: 'session.event', sub: 'key = user id', x: 48, y: 86},
      {id: 'consumer', kind: 'service', label: 'Audit consumer', sub: 'per-user order', x: 76, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'auth', kind: 'grpc', label: 'Validate / Revoke'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'put · touch · rotate · revoke-all'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
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
