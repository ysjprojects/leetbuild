import type {Problem} from '@/lib/types';

import {slidingSessionStep} from './steps/1-sliding-session';

/**
 * A single-topic Redis drill: a server-side session store whose lifetime is one EXPIRE, slid back
 * to the full TTL on every read — the mechanism behind "you stay logged in while you keep using it".
 */
export const redisSessionStoreProblem: Problem = {
  id: 'redis-session-store',
  title: 'Sessions with a sliding TTL',
  tagline:
    'One hash per session, one EXPIRE that slides on every read: the Redis session store behind every "remember me" cookie.',
  difficulty: 'easy',
  concepts: ['redis'],
  minutes: 12,
  statement: `# Sessions with a sliding TTL

A browser logs in once and then carries a cookie; every request after that must become "which user,
and what have we remembered about them" without hitting the user database. The answer is a
**server-side session**: a random id in the cookie, a hash in Redis under that id, and a time to
live that is **slid** back to its full length on every read, so a session dies after a fixed
idle window — not a fixed age. Rails, Django, Express's \`connect-redis\` and every API gateway with
a login page keep sessions exactly like this.

The whole mechanism is two commands used in the right order. \`HSET\` writes the fields and \`EXPIRE\`
sets the idle window; a read is \`HGETALL\` followed by \`EXPIRE\` again, which is the slide; \`DEL\` is
log-out. Redis evicts whatever is not read in time, so there is no sweeper, no \`last_seen\` column
and no cron job.

## What you build here

1. \`create(user_id, data)\`, \`get(sid)\`, \`touch(sid)\` and \`destroy(sid)\` over the hash \`sess:{sid}\`,
   with \`SESSION_TTL_S = 1800\` and a 32-hex-char id from a cryptographic random source.

## Left out on purpose

Cookie signing and the \`Set-Cookie\` header, CSRF tokens, an absolute lifetime on top of the idle one,
session fixation defences (rotating the id at login), and listing a user's sessions to revoke them
all — each is one more key or one more check on the same hash.`,
  diagram: {
    nodes: [
      {id: 'browser', kind: 'client', label: 'Browser', sub: 'cookie sid=…', x: 10, y: 50},
      {id: 'app', kind: 'service', label: 'app server', sub: 'create · get · touch · destroy', x: 45, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'sess:{sid} · EXPIRE 1800', x: 85, y: 50},
    ],
    edges: [
      {from: 'browser', to: 'app', kind: 'http', label: 'request + cookie'},
      {from: 'app', to: 'redis', kind: 'redis', label: 'HSET+EXPIRE · HGETALL+EXPIRE · DEL'},
    ],
  },
  steps: [slidingSessionStep],
};
